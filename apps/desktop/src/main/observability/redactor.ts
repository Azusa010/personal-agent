const REDACTION_RULES: ReadonlyArray<{ id: string, pattern: RegExp, replacement: string }> =
    [
        { id: "api-key", pattern: /(?<=apiKey=")[^"]+/, replacement: "***" },
        { id: "access_token", pattern: /(?<=access_token=")[^"]+/, replacement: "***" },
        { id: "refresh_token", pattern: /(?<=refresh_token=")[^"]+/, replacement: "***" },
        { id: "token", pattern: /(?<=token=")[^"]+/, replacement: "***" },
        { id: "password", pattern: /(?<=password=")[^"]+/, replacement: "***" },
        { id: "secret", pattern: /(?<=secret=")[^"]+/, replacement: "***" },
        { id: "authorization", pattern: /(?<=authorization=")[^"]+/, replacement: "***" }
    ]

export const sanitizeContext: any(context: undefined): undefined => {
    
}