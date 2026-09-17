const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

interface PairingInstructions {
  url: string;
  qr: string | null;
  expiresAt: string | null;
  columns?: number;
}

function visibleWidth(value: string): number {
  return Math.max(
    ...value
      .replace(ANSI_PATTERN, "")
      .split("\n")
      .map((line) => line.length),
  );
}

function formatQr(qr: string | null, columns: number | undefined): string {
  if (!qr) {
    return "QR code is unavailable. Use the pairing link below.";
  }

  if (columns === undefined) {
    return "QR code not shown because terminal width could not be detected.";
  }

  const width = visibleWidth(qr);
  if (columns <= width) {
    return `QR code not shown. Resize the terminal to at least ${width + 1} columns, then run this command again.`;
  }

  return qr;
}

function formatLinkWarning(expiresAt: string | null): string {
  if (expiresAt === null) {
    return "Treat this pairing link like a password. Anyone with it can access this daemon.";
  }
  const time = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `This link pairs one device and stops working at ${time}. Don't share it.`;
}

export function formatPairingInstructions({
  url,
  qr,
  expiresAt,
  columns,
}: PairingInstructions): string {
  return `\nScan to pair:\n${formatQr(qr, columns)}\n\nPairing link:\n${url}\n\n${formatLinkWarning(expiresAt)}\n`;
}
