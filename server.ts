import { createRequestHandler } from "@remix-run/cloudflare";
// @ts-ignore
import * as build from "./build/server/index.js";

const requestHandler = createRequestHandler(build);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
