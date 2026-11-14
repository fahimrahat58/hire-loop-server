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

    if (!payload.sub || !ObjectId.isValid(payload.sub)) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
      return;
    }

    const db = await connectDB();

    const user = await db.collection("user").findOne({
      _id: new ObjectId(payload.sub),
    });

    if (!user) {
      res.status(401).json({
        success: false,
        message: "User not found",
      });
      return;
    }

    req.authUser = {
      id: String(user._id),
      email: String(user.email || "")
        .trim()
        .toLowerCase(),
      name: String(user.name || ""),
      role: String(user.role || "seeker").toLowerCase(),
    };

    if (!req.authUser.email) {
      res.status(401).json({
        success: false,
        message: "Invalid user account",
      });
      return;
    }

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
      message: "Only job seekers can access this resource",
    });
    return;
  }

  next();
};

export const verifyRecruiter = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.authUser?.role !== "recruiter") {
    res.status(403).json({
      success: false,
      message: "Only recruiters can access this resource",
    });
    return;
  }

  next();
};

// Admin authorization always relies on the role loaded from MongoDB by
// verifyUser. A role claim from the client, the frontend session or the JWT is
// never trusted here.
export const verifyAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({
      success: false,
      message: "Only administrators can access this resource",
    });
    return;
  }

  next();
};
