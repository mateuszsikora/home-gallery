export type LogFields = Readonly<Record<string, boolean | number | string>>;

export interface BotLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

const writeLog = (
  level: 'error' | 'info' | 'warn',
  fields: LogFields,
  message: string,
): void => {
  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  });

  if (level === 'error') {
    console.error(entry);
  } else {
    console.log(entry);
  }
};

export const createConsoleLogger = (): BotLogger => ({
  info: (fields, message) => writeLog('info', fields, message),
  warn: (fields, message) => writeLog('warn', fields, message),
  error: (fields, message) => writeLog('error', fields, message),
});

const redact = (value: string, secrets: readonly string[]): string => {
  let redacted = value;

  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, '[REDACTED]');
    }
  }

  return redacted;
};

export const safeErrorFields = (
  error: unknown,
  secrets: readonly string[],
): LogFields => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: redact(error.message, secrets),
    };
  }

  return {
    errorName: 'UnknownError',
    errorMessage: redact(String(error), secrets),
  };
};
