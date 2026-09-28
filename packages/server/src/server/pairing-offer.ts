import type { Logger } from "pino";

import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { MAX_RELAY_INVITATION_TTL_MS, RelayDeviceStore } from "./relay-auth/store.js";
import { getOrCreateServerId } from "./server-id.js";

export interface LocalPairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
  /** When the one-time pairing link stops working. */
  expiresAt: string | null;
}

export async function generateLocalPairingOffer(args: {
  paseoHome: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  /** Mirrors `daemon.relay.deviceAuth`: only then does the link carry a one-time token. */
  deviceAuth: boolean;
  appBaseUrl?: string;
  includeQr?: boolean;
  logger?: Logger;
}): Promise<LocalPairingOffer> {
  const relayEnabled = args.relayEnabled ?? true;
  if (!relayEnabled) {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
      expiresAt: null,
    };
  }

  const relayEndpoint = args.relayEndpoint ?? "relay.paseo.sh:443";
  const relayPublicEndpoint = args.relayPublicEndpoint ?? relayEndpoint;
  const relayUseTls = args.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
  const relayPublicUseTls = args.relayPublicUseTls ?? relayUseTls;
  const appBaseUrl = args.appBaseUrl ?? "https://app.paseo.sh";
  const serverId = getOrCreateServerId(args.paseoHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.paseoHome, args.logger);
  const invitation = args.deviceAuth
    ? new RelayDeviceStore({
        paseoHome: args.paseoHome,
        logger: args.logger,
      }).createInvitation({ ttlMs: MAX_RELAY_INVITATION_TTL_MS, now: new Date() })
    : null;
  const offer = await createConnectionOfferV2({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    relay: { endpoint: relayPublicEndpoint, useTls: relayPublicUseTls },
    pairing: invitation,
  });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });

  if (args.includeQr === false) {
    return {
      relayEnabled: true,
      url,
      qr: null,
      expiresAt: invitation?.expiresAt ?? null,
    };
  }

  let qr: string | null = null;
  try {
    qr = await renderPairingQr(url);
  } catch (error) {
    args.logger?.debug({ error }, "Failed to render pairing QR");
  }

  return {
    relayEnabled: true,
    url,
    qr,
    expiresAt: invitation?.expiresAt ?? null,
  };
}
