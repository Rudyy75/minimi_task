import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_PATH: z.string().default("./data/minimi.sqlite"),
  TIME_ZONE: z.string().default("UTC"),
  LOCALE: z.string().default("en-US"),
});

export const config = schema.parse(process.env);
