const KEY_VALUE_PATTERN = /((?:api_key|access_token|refresh_token|token|password|passwd|secret|authorization)[ \t]*[:=][ \t]*)((?:Bearer|Basic|Token)[ \t]+)?("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi;
const BEARER_PATTERN = /\b(Bearer)[ \t]+([A-Za-z0-9._~+\/=-]{8,})/gi;

const REDACTION_RULES: ReadonlyArray<{ id: string, pattern: RegExp, replacement: string }> =
    [
        { id: 'alternation', pattern: KEY_VALUE_PATTERN, replacement: '$1***' },
        { id: 'bearer', pattern: BEARER_PATTERN, replacement: '$1 ***' }

    ]

export function redactText(text: string): string {
    return REDACTION_RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replacement), text);
}



export const sanitizeContext: any(context: undefined): undefined => {

}