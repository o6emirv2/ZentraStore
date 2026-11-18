"use strict";
const crypto = require("node:crypto"),
  C = require("./common");
const { purposeKey } = require("../core/adminAccessService");
const { getEffectiveCatalog } = require("../core/storeCatalogService");
const TTL = 5 * 60000;
const signature = (value) =>
  crypto
    .createHmac("sha256", purposeKey("commerce-quote-v1"))
    .update(value)
    .digest();
function encode(claims) {
  const text = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return text + "." + signature(text).toString("base64url");
}
function verify(token, uid) {
  if (typeof token !== "string" || token.length > 20000)
    C.fail("COMMERCE_QUOTE_INVALID", 409);
  const [text, sign, extra] = token.split(".");
  if (extra || !text || !sign) C.fail("COMMERCE_QUOTE_INVALID", 409);
  let actual;
  try {
    actual = Buffer.from(sign, "base64url");
  } catch {
    C.fail("COMMERCE_QUOTE_INVALID", 409);
  }
  const expected = signature(text);
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  )
    C.fail("COMMERCE_QUOTE_INVALID", 409);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(text, "base64url").toString());
  } catch {
    C.fail("COMMERCE_QUOTE_INVALID", 409);
  }
  if (
    claims.uid !== uid ||
    claims.expiresAt < Date.now() ||
    claims.expiresAt > Date.now() + TTL + 60000
  )
    C.fail("COMMERCE_QUOTE_EXPIRED", 409);
  return claims;
}
function intent(items) {
  return C.array(items, 20).map((x) => {
    C.object(x, ["productId", "planKey", "quantity", "expectedUnitPriceKurus"]);
    return {
      productId: C.id(x.productId, 80),
      planKey: C.id(x.planKey, 40),
      quantity: C.integer(x.quantity, 1, 5),
      ...(x.expectedUnitPriceKurus === undefined
        ? {}
        : { expectedUnitPriceKurus: C.integer(x.expectedUnitPriceKurus, 1) }),
    };
  });
}
function pricedCart(cart, metadata) {
  const items = cart.items.map((item) => {
    const meta = metadata.get(item.productId)?.published || {},
      quantity = cart.items
        .filter((x) => x.productId === item.productId)
        .reduce((s, x) => s + x.quantity, 0),
      tier = (meta.volumeTiers || [])
        .filter((x) => quantity >= x.quantity)
        .at(-1),
      unitPriceKurus = tier
        ? Math.max(
            1,
            Math.floor((item.unitPriceKurus * (100 - tier.percentOff)) / 100),
          )
        : item.unitPriceKurus;
    return {
      ...item,
      unitPriceKurus,
      lineTotalKurus: unitPriceKurus * item.quantity,
    };
  });
  return { items, totalKurus: items.reduce((s, x) => s + x.lineTotalKurus, 0) };
}
async function prepare(uid, input) {
  C.object(input, [
    "items",
    "paymentMethod",
    "promotionCode",
    "giftRecipientUid",
  ]);
  await require("./settings").assertAvailable("orders");
  await C.activeUser(uid, { purchase: true });
  const raw = intent(input.items),
    method = C.choice(input.paymentMethod, ["wallet", "telegram"]),
    promotionCode = C.text(input.promotionCode || "", 32).toUpperCase(),
    giftRecipientUid = input.giftRecipientUid
      ? C.uid(input.giftRecipientUid)
      : "",
    database = C.db(),
    catalog = await getEffectiveCatalog({
      includeInactive: false,
      fresh: true,
    }),
    base = require("../core/storeService").normalizeCart(
      raw.map(({ expectedUnitPriceKurus, ...x }) => x),
      catalog,
    ),
    metas = await database.getAll(
      ...[...new Set(base.items.map((x) => x.productId))].map((id) =>
        database.collection("storeProductDetails").doc(id),
      ),
    ),
    metadata = new Map(metas.map((s) => [s.id, s.data() || {}])),
    cart = pricedCart(base, metadata);
  if (
    method === "wallet" &&
    (catalog.storefront?.services?.automaticDelivery === false ||
      catalog.storefront?.services?.balancePayment === false ||
      base.items.some(
        (i) =>
          i.fulfillmentMode === "telegram_only" || i.automaticEnabled === false,
      ))
  )
    C.fail("STORE_AUTOMATIC_CHANNEL_DISABLED", 409);
  if (
    method === "telegram" &&
    (catalog.storefront?.services?.telegramSupport === false ||
      base.items.some((i) => i.telegramEnabled === false))
  )
    C.fail("STORE_TELEGRAM_CHANNEL_DISABLED", 409);
  if (giftRecipientUid) {
    if (
      giftRecipientUid === uid ||
      base.items.some(
        (i) => metadata.get(i.productId)?.published?.giftEligible !== true,
      )
    )
      C.fail("COMMERCE_GIFT_NOT_ELIGIBLE", 409);
    const { auth } = require("../config/firebaseAdmin").initFirebaseAdmin(),
      recipient = await auth.getUser(giftRecipientUid);
    if (recipient.disabled || !recipient.emailVerified)
      C.fail("COMMERCE_RECIPIENT_NOT_FOUND", 404);
    await C.activeUser(giftRecipientUid);
  }
  const promotion = promotionCode
    ? await require("../core/storePromotionService").previewPromotion({
        uid,
        code: promotionCode,
        cart,
      })
    : null;
  const now = Date.now(),
    claims = {
      uid,
      items: cart.items.map((x) => ({
        productId: x.productId,
        planKey: x.planKey,
        quantity: x.quantity,
        unitPriceKurus: x.unitPriceKurus,
      })),
      paymentMethod: method,
      promotionCode,
      giftRecipientUid,
      metadataRevisions: Object.fromEntries(
        [...metadata].map(([id, row]) => [id, row.publishedRevision || 0]),
      ),
      catalogRevision: catalog.revision || "",
      subtotalKurus: cart.totalKurus,
      totalKurus: promotion?.totalKurus ?? cart.totalKurus,
      quoteId: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + TTL,
    };
  return {
    token: encode(claims),
    items: cart.items,
    subtotalKurus: cart.totalKurus,
    totalKurus: claims.totalKurus,
    promotion,
    expiresAt: claims.expiresAt,
    giftRecipientUid,
    changes: cart.items.flatMap((i) => {
      const previous = raw.find(
        (x) => x.productId === i.productId && x.planKey === i.planKey,
      )?.expectedUnitPriceKurus;
      return previous !== undefined && previous !== i.unitPriceKurus
        ? [
            {
              productId: i.productId,
              planKey: i.planKey,
              previousUnitPriceKurus: previous,
              unitPriceKurus: i.unitPriceKurus,
            },
          ]
        : [];
    }),
  };
}
async function transactionContext(
  tx,
  database,
  claims,
  { uid, cart, reservationId = "" },
) {
  if (claims.uid !== uid || claims.expiresAt < Date.now())
    C.fail("COMMERCE_QUOTE_EXPIRED", 409);
  const docs = await Promise.all(
    Object.keys(claims.metadataRevisions).map(async (id) => [
      id,
      await tx.get(database.collection("storeProductDetails").doc(id)),
    ]),
  );
  const metadata = new Map(docs.map(([id, s]) => [id, s.data() || {}]));
  for (const [id, revision] of Object.entries(claims.metadataRevisions))
    if ((metadata.get(id)?.publishedRevision || 0) !== revision)
      C.fail("COMMERCE_QUOTE_STALE", 409);
  const priced = pricedCart(cart, metadata);
  if (
    JSON.stringify(
      priced.items.map((x) => ({
        productId: x.productId,
        planKey: x.planKey,
        quantity: x.quantity,
        unitPriceKurus: x.unitPriceKurus,
      })),
    ) !== JSON.stringify(claims.items)
  )
    C.fail("STORE_PRICE_CHANGED", 409);
  let recipientUid = uid;
  if (claims.giftRecipientUid) {
    await C.activeUser(claims.giftRecipientUid, { transaction: tx, database });
    if (
      priced.items.some(
        (i) => metadata.get(i.productId)?.published?.giftEligible !== true,
      )
    )
      C.fail("COMMERCE_GIFT_NOT_ELIGIBLE", 409);
    recipientUid = claims.giftRecipientUid;
  }
  let reservation = null;
  if (reservationId) {
    const snap = await tx.get(
      database.collection("storeReservations").doc(C.id(reservationId)),
    );
    reservation = snap.data();
    if (
      !reservation ||
      reservation.uid !== uid ||
      reservation.state !== "active" ||
      reservation.expiresAt < Date.now() ||
      reservation.quoteHash !== C.hash(encode(claims))
    )
      C.fail("COMMERCE_RESERVATION_EXPIRED", 409);
    reservation = { ...reservation, id: snap.id };
  }
  const costs = priced.items.map((x) => ({
    productId: x.productId,
    quantity: x.quantity,
    unitCostKurus: metadata.get(x.productId)?.published?.unitCostKurus,
  }));
  const reservationOwner = reservation
    ? await tx.get(
        database.collection("storeReservationOwners").doc(C.hash(uid)),
      )
    : null;
  return { cart: priced, recipientUid, reservation, reservationOwner, costs };
}
function commit(tx, database, context, order) {
  if (context.reservation)
    tx.update(
      database.collection("storeReservations").doc(context.reservation.id),
      { state: "consumed", orderId: order.id, consumedAt: Date.now() },
    );
  if (
    context.reservationOwner &&
    context.reservation &&
    context.reservationOwner.data()?.reservationId === context.reservation.id
  )
    tx.set(
      context.reservationOwner.ref,
      { reservationId: "", expiresAt: 0 },
      { merge: true },
    );
  tx.create(database.collection("storeOrderCostSnapshots").doc(order.id), {
    orderId: order.id,
    uid: order.uid,
    totalKurus: order.totalKurus,
    costKurus: context.costs.reduce(
      (s, x) =>
        s +
        (Number.isSafeInteger(x.unitCostKurus)
          ? x.unitCostKurus * x.quantity
          : 0),
      0,
    ),
    feesKurus: 0,
    verified: context.costs.every((x) => Number.isSafeInteger(x.unitCostKurus)),
    feesVerified: false,
    createdAt: order.createdAt,
  });
}
module.exports = {
  TTL,
  encode,
  verify,
  intent,
  pricedCart,
  prepare,
  transactionContext,
  commit,
};
