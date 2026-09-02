import * as z from "zod";

export const PROTOCOL_VERSION = "0.1";

export const InitializeParams = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    client: z.object({
        name:z.string(),
        version:z.string(),
    })
})

export const InitializeResult = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    server: z.object({
        name:z.string(),
        version:z.string(),
    })
})
