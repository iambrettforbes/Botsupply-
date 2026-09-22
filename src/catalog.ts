/** Intended retail value of one credit. Documented only — this API never charges a card. */
export const CREDIT_VALUE_USD = 0.01;

export type ProductKind = "pack" | "recipe";

export type Product = {
  sku: string;
  name: string;
  kind: ProductKind;
  description: string;
  price_credits: number;
  payload: Record<string, unknown>;
};

const competitorSnapshot = {
  pack: "competitor-snapshot",
  version: "2026.09",
  market: {
    metro: "New York",
    neighborhood: "Cobble Hill",
    segment: "independent casual dining",
    as_of: "2026-09-15",
  },
  competitors: [
    {
      name: "Harbor & Rye",
      venue_id: "v_harbor_rye",
      price_band: "$$",
      avg_check_usd: 46,
      covers_fri_peak: 92,
      reservation_lead_days: 4,
      peak_turns: ["18:15", "20:00"],
      signature_items: ["rye old fashioned", "dry-aged smash burger", "charred broccolini"],
      review_themes: [
        { theme: "warm service", sentiment: "positive", mentions: 38 },
        { theme: "slow Saturday seating", sentiment: "negative", mentions: 11 },
      ],
      promo_watch: "Weekday prix fixe $38 before 18:00",
    },
    {
      name: "Lumen Noodle",
      venue_id: "v_lumen_noodle",
      price_band: "$$",
      avg_check_usd: 31,
      covers_fri_peak: 140,
      reservation_lead_days: 1,
      peak_turns: ["19:00", "21:00"],
      signature_items: ["chili oil dumplings", "cold sesame noodles"],
      review_themes: [
        { theme: "fast turnover", sentiment: "mixed", mentions: 22 },
        { theme: "spicy menu", sentiment: "positive", mentions: 41 },
      ],
      promo_watch: "None this week",
    },
    {
      name: "Salt Lane",
      venue_id: "v_salt_lane",
      price_band: "$$$",
      avg_check_usd: 78,
      covers_fri_peak: 64,
      reservation_lead_days: 12,
      peak_turns: ["17:45", "20:30"],
      signature_items: ["crudo", "dry-aged duck", "natural wine flight"],
      review_themes: [
        { theme: "hard to book", sentiment: "negative", mentions: 27 },
        { theme: "special occasion", sentiment: "positive", mentions: 33 },
      ],
      promo_watch: "Bar seats released at 10:00 local, day-of",
    },
  ],
};

const venueHours = {
  pack: "venue-hours",
  version: "2026.09",
  timezone: "America/New_York",
  venues: [
    {
      venue_id: "v_harbor_rye",
      name: "Harbor & Rye",
      address: "418 Atlantic Ave, Brooklyn, NY 11217",
      phone: "+1-718-555-0148",
      hours: {
        mon: null,
        tue: { open: "17:00", close: "22:00" },
        wed: { open: "17:00", close: "22:00" },
        thu: { open: "17:00", close: "22:30" },
        fri: { open: "17:00", close: "23:00" },
        sat: { open: "11:00", close: "23:00" },
        sun: { open: "11:00", close: "21:00" },
      },
      kitchen_close_min_before: 45,
      reservation_policy: "Parties of 7 or more need 24 hours notice. The bar is walk-in.",
      slot_minutes: 15,
    },
    {
      venue_id: "v_lumen_noodle",
      name: "Lumen Noodle",
      address: "90 Court St, Brooklyn, NY 11201",
      phone: "+1-718-555-0162",
      hours: {
        mon: { open: "11:30", close: "21:30" },
        tue: { open: "11:30", close: "21:30" },
        wed: { open: "11:30", close: "21:30" },
        thu: { open: "11:30", close: "22:00" },
        fri: { open: "11:30", close: "22:30" },
        sat: { open: "12:00", close: "22:30" },
        sun: { open: "12:00", close: "21:00" },
      },
      kitchen_close_min_before: 30,
      reservation_policy: "Reservations for parties of 4 or more. Smaller parties join the walk-in list.",
      slot_minutes: 15,
    },
    {
      venue_id: "v_salt_lane",
      name: "Salt Lane",
      address: "12 Smith St, Brooklyn, NY 11201",
      phone: "+1-347-555-0114",
      hours: {
        mon: null,
        tue: null,
        wed: { open: "17:30", close: "22:00" },
        thu: { open: "17:30", close: "22:00" },
        fri: { open: "17:30", close: "23:00" },
        sat: { open: "17:00", close: "23:00" },
        sun: { open: "17:00", close: "21:30" },
      },
      kitchen_close_min_before: 60,
      reservation_policy: "Booked tables only. Parties of 6 or more require a card hold.",
      slot_minutes: 30,
    },
  ],
};

const bookTable = {
  recipe: "book-table",
  version: "1.2.0",
  summary:
    "Reserve a table at a partner venue. Check pack.venue-hours before calling the venue. BotSupply delivers this recipe; the buying agent executes it.",
  inputs: [
    { name: "venue_id", type: "string", required: true },
    { name: "party_size", type: "integer", minimum: 1, maximum: 12, required: true },
    { name: "date", type: "string", format: "date", required: true },
    { name: "time", type: "string", format: "HH:mm", required: true },
    { name: "guest_name", type: "string", required: true },
    { name: "phone", type: "string", required: true },
    { name: "notes", type: "string", required: false },
  ],
  steps: [
    {
      id: "load_hours",
      action: "use_pack",
      sku: "pack.venue-hours",
      detail: "Select the venue and the weekday that matches date.",
    },
    {
      id: "check_open",
      action: "assert",
      detail: "Stop if the venue is closed that day, or if time falls inside the kitchen-close window.",
    },
    {
      id: "party_policy",
      action: "assert",
      detail: "If party_size is 7 or more, the request must be at least 24 hours before the slot.",
    },
    {
      id: "hold_slot",
      action: "call_venue",
      channel: "phone_or_partner_api",
      detail: "Ask for a hold on the slot under guest_name. Use the venue phone from the hours pack.",
    },
    {
      id: "confirm",
      action: "confirm",
      detail: "Read the confirmation code back to the guest and keep it with the request.",
    },
  ],
  failures: [
    {
      code: "closed",
      when: "No hours for that weekday",
      agent_says: "That venue is closed then. I can check another night.",
    },
    {
      code: "kitchen_closed",
      when: "Inside the kitchen-close window",
      agent_says: "The kitchen stops seating that late.",
    },
    {
      code: "large_party_lead",
      when: "Party of 7 or more inside 24 hours",
      agent_says: "Large parties need a day's notice.",
    },
    {
      code: "no_availability",
      when: "The venue declines the hold",
      agent_says: "That slot is gone. I can try the next turn.",
    },
  ],
  example: {
    request: {
      venue_id: "v_harbor_rye",
      party_size: 2,
      date: "2026-09-26",
      time: "19:00",
      guest_name: "Avery Chen",
      phone: "+1-917-555-0199",
      notes: "Anniversary, booth if possible",
    },
    confirmation: {
      status: "confirmed",
      confirmation_code: "HR-7K2Q",
      venue_id: "v_harbor_rye",
      date: "2026-09-26",
      time: "19:00",
      party_size: 2,
    },
  },
};

export const PRODUCTS: readonly Product[] = [
  {
    sku: "pack.competitor-snapshot",
    name: "Competitor Snapshot",
    kind: "pack",
    description:
      "A point-in-time competitive set for Cobble Hill casual dining: price band, Friday covers, peak turns, signature items, and review themes.",
    price_credits: 50,
    payload: competitorSnapshot,
  },
  {
    sku: "pack.venue-hours",
    name: "Venue Hours",
    kind: "pack",
    description:
      "Normalized weekly hours, kitchen-close offset, and reservation policy for the partner venues a booking agent needs before it calls.",
    price_credits: 20,
    payload: venueHours,
  },
  {
    sku: "recipe.book-table",
    name: "Book a Table",
    kind: "recipe",
    description:
      "An executable booking recipe: required inputs, ordered steps, failure lines, and a sample confirmation. The agent runs it; BotSupply does not place the reservation.",
    price_credits: 100,
    payload: bookTable,
  },
];

export function findProduct(sku: string): Product | undefined {
  return PRODUCTS.find((product) => product.sku === sku);
}

export function priceUsd(credits: number): number {
  return Number((credits * CREDIT_VALUE_USD).toFixed(2));
}

export function catalogDocument() {
  return {
    credit_value_usd: CREDIT_VALUE_USD,
    note: "1 credit = $0.01 intended retail. Credits are prepaid units. This API does not charge a card.",
    products: PRODUCTS.map((product) => ({
      sku: product.sku,
      name: product.name,
      kind: product.kind,
      description: product.description,
      price_credits: product.price_credits,
      price_usd: priceUsd(product.price_credits),
    })),
  };
}
