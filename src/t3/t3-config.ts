import { z } from "zod";

export const T3ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  base_url: z.string().url().default("http://127.0.0.1:3773"),
  access_token_env: z.string().min(1).default("T3_ACCESS_TOKEN"),
  request_timeout_ms: z.number().int().positive().default(15000),
});

export type T3Config = z.infer<typeof T3ConfigSchema>;

export const T3_CONFIG_DEFAULTS: T3Config = {
  enabled: false,
  base_url: "http://127.0.0.1:3773",
  access_token_env: "T3_ACCESS_TOKEN",
  request_timeout_ms: 15000,
};
