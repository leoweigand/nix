import { z } from "zod";
export const buttons = z
  .array(
    z.object({
      label: z.string().min(1).max(80),
      url: z
        .string()
        .max(2048)
        .url()
        .refine((url) => new URL(url).protocol === "https:")
        .optional(),
    }),
  )
  .max(6);
