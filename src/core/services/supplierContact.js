/**
 * Privacy layer for supplier ↔ customer contact — GetYourGuide's model.
 *
 * A supplier must be able to run the booking: coordinate a pickup, confirm a
 * meeting point, reach a guest who is late. That does not require the
 * customer's real email address, and handing it over lets anyone with supplier
 * access collect the platform's customers and contact them outside the
 * platform forever. So the address a supplier sees and mails is a RELAY:
 *
 *   supplier  ->  c-<16-hex-hmac>@<receiving-domain>   (the chat Reply-To)
 *                     |  resolved by conversation replyToken, sender verified
 *   customer  <-  real inbox
 *
 * This is not a new mechanism: chat notification mail has carried this address
 * since the relay was built (chatInbound.ensureConversationToken), which is
 * why a supplier who copies the address and mails it still reaches the guest —
 * and the message lands in the app thread as well, so the platform keeps its
 * archive for disputes. Bookings simply reuse that address.
 *
 * Decisions, made deliberately:
 *  - ONE ADDRESS PER CUSTOMER-AND-SUPPLIER PAIR, not per booking: a repeat
 *    guest is the same address on every trip, and it matches the conversation
 *    the supplier already has.
 *  - NO EXPIRY: the pair keeps the address. (GetYourGuide's documented window
 *    closes 7 days after the activity; we chose to keep it open so a returning
 *    guest stays reachable — same address, same thread.)
 *  - THE ALIAS IS A KEYED TOKEN, NOT A DIGEST: an HMAC keyed by server secrets
 *    cannot be reversed, guessed, or checked against a wordlist the way a hash
 *    of an email could — and a hash could not deliver a message anyway.
 *  - THE REAL ADDRESS NEVER LEAVES THE SERVER for a supplier role. It is not
 *    hidden in the UI: the supplier-facing API responses carry the relay in
 *    its place, and email templates that address the supplier render it too.
 *  - A FAILURE TO MINT A RELAY BLANKS THE ADDRESS. The fallback is the
 *    customer's name, never the real email.
 */

const prisma = require('./prismaClient');
const chatInbound = require('./chatInbound');
const chatService = require('./chatService');
const logger = require('./logger');

// Resolving an address costs one conversation lookup plus the occasional
// create, so results are cached per customer-and-supplier pair. Bounded: a
// supplier with more distinct customers than this simply pays the lookup
// again for the oldest pair.
const MAX_CACHE = 1000;
const cache = new Map();

function cacheKeyFor(booking, supplierId) {
  return `${supplierId || booking.tour?.supplierId || ''}|${booking.customerId || ''}`;
}

function remember(key, value) {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/** Clears the in-memory alias cache (tests). */
function clearContactCache() {
  cache.clear();
}

/**
 * The relay address for the customer behind this booking, resolving (and, if
 * missing, creating) the SUPPLIER-CUSTOMER conversation. Returns null when it
 * cannot be minted — the caller blanks the address rather than falling back to
 * the real one.
 */
async function contactAddressForBooking(booking) {
  const supplierId = booking.tour?.supplierId;
  const customerId = booking.customerId;
  if (!supplierId || !customerId) return null;

  const key = cacheKeyFor(booking);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const conversation = await chatService.findOrCreateConversation(
      supplierId,
      customerId,
      'SUPPLIER_CUSTOMER',
      {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        tourTitle: booking.tour?.title || null,
      },
    );
    // Canonical stored token: c-<16 hex>, matching the inbound parser.
    await chatInbound.ensureConversationToken(prisma, conversation.id);
    const address = chatInbound.replyAddressFor(
      conversation.id,
      booking.brand || conversation.brand || null,
    );
    remember(key, address);
    return address;
  } catch (err) {
    // Loud, and never substituted with the real address.
    logger.warn(`[SupplierContact] could not mint a relay for booking ${booking.id}: ${err.message}`);
    remember(key, null);
    return null;
  }
}

/**
 * Batch form for list endpoints: one relay per booking, resolved per distinct
 * customer. Existing conversations are found in ONE query rather than one per
 * row — a 50-row list must not become 50 lookups — and only genuinely missing
 * pairs are created (normally none: the conversation already exists from the
 * first chat message).
 */
async function contactAddressesForBookings(bookings, supplierId) {
  const out = new Map();
  const pending = [];

  for (const booking of bookings) {
    if (!booking.customerId) continue;
    const key = cacheKeyFor(booking, supplierId);
    const cached = cache.get(key);
    if (cached !== undefined) out.set(booking.id, cached);
    else pending.push(booking);
  }
  if (pending.length === 0) return out;

  const customerIds = [...new Set(pending.map((b) => b.customerId))];
  let existing = [];
  try {
    existing = await prisma.conversation.findMany({
      where: {
        type: 'SUPPLIER_CUSTOMER',
        participants: { some: { userId: { in: customerIds } } },
      },
      select: {
        id: true,
        brand: true,
        participants: { select: { userId: true } },
      },
    });
  } catch (err) {
    logger.warn(`[SupplierContact] batch lookup failed: ${err.message}`);
  }

  const byCustomer = new Map();
  for (const conv of existing) {
    const participantIds = (conv.participants || []).map((p) => p.userId);
    if (!participantIds.includes(supplierId)) continue;
    for (const cid of participantIds) {
      if (cid !== supplierId && !byCustomer.has(cid)) byCustomer.set(cid, conv);
    }
  }

  for (const booking of pending) {
    const conversation = byCustomer.get(booking.customerId);
    if (conversation) {
      try {
        await chatInbound.ensureConversationToken(prisma, conversation.id);
        const address = chatInbound.replyAddressFor(
          conversation.id,
          booking.brand || conversation.brand || null,
        );
        remember(cacheKeyFor(booking, supplierId), address);
        out.set(booking.id, address);
        continue;
      } catch {
        /* fall through to the single-booking path */
      }
    }
    out.set(booking.id, await contactAddressForBooking(booking));
  }

  return out;
}

/**
 * Put the relay in place of the customer's real email in one booking row.
 *
 * `leadTravelerEmail` is masked too: it is the person going on the trip, and a
 * supplier collecting guest addresses is exactly the collection this layer
 * exists to prevent. Phone is deliberately left alone — the driver has to
 * reach a guest who is late.
 */
function withSupplierContact(row, address) {
  const blank = {
    ...row,
    customer: row.customer ? { ...row.customer, email: '' } : row.customer,
    leadTravelerEmail: '',
  };
  if (!address) return blank;

  return {
    ...row,
    customer: row.customer ? { ...row.customer, email: address } : row.customer,
    leadTravelerEmail: row.leadTravelerEmail ? address : row.leadTravelerEmail,
  };
}

module.exports = {
  contactAddressForBooking,
  contactAddressesForBookings,
  withSupplierContact,
  clearContactCache,
};
