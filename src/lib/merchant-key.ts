import { prisma } from "@/lib/prisma";
import { decryptSecretKey } from "@/lib/encryption";

/**
 * Get the decrypted merchant sk_live_ key from Settings.
 * Returns null if no key is configured.
 */
export async function getMerchantKey(): Promise<string | null> {
  const settings = await prisma.settings.findFirst({
    select: { satsrailApiKeyEncrypted: true },
  });

  if (!settings?.satsrailApiKeyEncrypted) {
    return null;
  }

  return decryptSecretKey(settings.satsrailApiKeyEncrypted);
}
