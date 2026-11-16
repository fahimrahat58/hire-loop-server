import "dotenv/config";
import type { Request, Response, NextFunction } from "express";
export interface AuthRequest extends Request {
    authUser?: {
        id: string;
        email: string;
        name: string;
        role: string;
    };
}
export declare const verifyUser: (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export type UserRole = "seeker" | "recruiter" | "admin";
export declare const verifyRole: (...allowedRoles: UserRole[]) => (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const verifySeeker: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const verifyRecruiter: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const verifyAdmin: (req: AuthRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map