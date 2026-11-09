import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { authPlugins } from "../app/lib/auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg" }),
  plugins: authPlugins(async () => {}, { baseURL: "http://localhost:5173" }),
});
