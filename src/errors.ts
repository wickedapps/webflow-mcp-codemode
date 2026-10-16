// The message of something caught. Anything can be thrown in JavaScript, not only Errors.
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
