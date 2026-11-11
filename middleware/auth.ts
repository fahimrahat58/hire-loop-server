import "dotenv/config";

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";
import { connectDB } from "../config/db.js";

const rawAuthBaseUrl = process.env.AUTH_BASE_URL?.trim();

if (!rawAuthBaseUrl) {
  throw new Error("AUTH_BASE_URL is missing");
}

let authBaseUrl: URL;

try {
  authBaseUrl = new URL(rawAuthBaseUrl);
} catch {
  throw new Error("AUTH_BASE_URL must be a valid URL");
}

/**
 * Better Auth normalizes its `baseURL` to an origin before signing JWTs
 * (`new URL(baseURL).origin`), so the default `iss`/`aud` claims never
 * include a trailing slash or path. Normalize the value we compare against
 * the same way so `AUTH_BASE_URL` may be configured with or without a
 * trailing slash.
 *
 * Env overrides are only needed if the JWT plugin is configured with
 * explicit `jwt.issuer` / `jwt.audience` values.
 */
const authOrigin = authBaseUrl.origin;
const expectedIssuer = process.env.AUTH_JWT_ISSUER?.trim() || authOrigin;
const expectedAudience = process.env.AUTH_JWT_AUDIENCE?.trim() || authOrigin;

const JWKS = createRemoteJWKSet(new URL("/api/auth/jwks", authOrigin));

export interface AuthRequest extends Request {
  authUser?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export const verifyUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const token = authorization.slice(7);

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: expectedIssuer,
      audience: expectedAudience,
    });

    if (!payload.sub) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
      return;
    }

    const db = await connectDB();

    /**
     * Better Auth stores MongoDB user IDs as ObjectIds, while the JWT `sub`
     * claim is the string form of that ID. Query with an ObjectId so the
     * lookup actually matches the stored document.
     */
    const userId = payload.sub;

    if (!ObjectId.isValid(userId)) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
      return;
    }

    const user = await db
      .collection("user")
      .findOne({ _id: new ObjectId(userId) });

    if (!user) {
      res.status(401).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    req.authUser = {
      id: String(user._id),
      email: String(user.email).toLowerCase(),
      name: String(user.name || ""),
      role: String(user.role || "seeker"),
    };

    next();
  } catch (error) {
    console.error("AUTH VERIFICATION ERROR:", error);

    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

export const verifySeeker = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.authUser?.role !== "seeker") {
    res.status(403).json({
      success: false,
      message: "Only job seekers can access saved jobs",
    });
    return;
  }

  next();
};
