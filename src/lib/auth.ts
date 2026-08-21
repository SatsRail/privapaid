import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { satsrail } from "@/lib/satsrail";
import { normalizeSatsRailApiUrl } from "@/config/instance";

declare module "next-auth" {
  interface User {
    type?: "admin";
    role?: string;
  }

  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      type?: "admin";
      role?: string;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    userId?: string;
    type?: "admin";
    role?: string;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      id: "admin",
      name: "Staff Login",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const settings = await prisma.settings.findFirst({
          where: { setupCompleted: true },
        });
        if (!settings?.merchantId || !settings?.satsrailApiUrl) return null;

        try {
          const session = await satsrail.createSession(
            credentials.email as string,
            credentials.password as string,
            normalizeSatsRailApiUrl(settings.satsrailApiUrl)
          );

          const merchant = session.merchants.find(
            (m) => m.id === settings.merchantId
          );
          if (!merchant) return null;

          return {
            id: merchant.id,
            email: credentials.email as string,
            name: merchant.name,
            role: merchant.role,
            type: "admin" as const,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.type = user.type;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.type = token.type;
        session.user.role = token.role;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  trustHost: true,
});
