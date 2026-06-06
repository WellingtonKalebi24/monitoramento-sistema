import jwt from "jsonwebtoken";
import { FastifyRequest } from "fastify";
import { env } from "./env.js";

export type AuthUser = {
  id: string;
  tenantId: string | null;
  name: string;
  email: string;
  role: "master_admin" | "tenant_admin";
};

export function signToken(user: AuthUser) {
  return jwt.sign(user, env.JWT_SECRET, {
    expiresIn: "12h"
  });
}

export function getAuthUser(request: FastifyRequest): AuthUser | null {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  try {
    return jwt.verify(
      authorization.slice("Bearer ".length),
      env.JWT_SECRET
    ) as AuthUser;
  } catch {
    return null;
  }
}

export function requireAuth(request: FastifyRequest): AuthUser {
  const user = getAuthUser(request);

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  return user;
}

export function tenantScope(user: AuthUser, requestedTenantId?: string) {
  if (user.role === "master_admin") {
    return requestedTenantId ?? null;
  }

  return user.tenantId;
}

