export const ExitCode = {
  success: 0,
  unexpected: 1,
  usage: 2,
  authentication: 3,
  forbidden: 4,
  notFound: 5,
  conflict: 6,
  validation: 7,
  unavailable: 8,
  canceled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
