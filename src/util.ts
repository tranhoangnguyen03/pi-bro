export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function withDoctor(error: unknown): string {
	const message = errorMessage(error);
	return message.includes("/bro doctor") ? message : `${message}\n\nRun \`/bro doctor\` for setup help.`;
}

export function fileError(path: string, error: unknown): Error {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return new Error(`File not found: ${path}`);
	if (code === "EACCES" || code === "EPERM") return new Error(`File is not readable: ${path}`);
	return new Error(`Could not read ${path}: ${errorMessage(error)}`);
}

export function unquote(value: string): string {
	if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
		return value.slice(1, -1);
	}
	return value;
}
