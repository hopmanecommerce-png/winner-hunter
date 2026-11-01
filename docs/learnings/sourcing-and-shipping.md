# Sourcing and shipping to the EU (research, 2026-11-01)

This research session covered getting an approved product from a Chinese supplier to EU customers. The capture starts at supplier question 4, so the earlier part is missing, including the detailed EU customs and VAT rules for 2026. Only the references in the plan and checklists below survive. Points from the other two research sessions are marked **[LLM]** ([ai-and-data-upgrades.md](ai-and-data-upgrades.md)) and **[data sources]** ([data-sources.md](data-sources.md)).

## Suppliers and routes (as captured)

| Route | What was captured |
|---|---|
| 1688, through a sourcing agent | Samples are ordered through the agent and paid on 1688. The agent does the QC (photos, function video, measurements) and can hold 20–50 units of starter stock. [LLM] The official 1688 API likely needs a Chinese business licence. |
| CJ | Check whether CJ stocks the product in Frankfurt, and CJ's EU stock and fees per product. [data sources] CJ's search by image needs a Level 3 account. [LLM] CJ's quota for an account with no CJ spend is unknown. |
| Shipping lines | Ask the agent for 0.5/1 kg express quotes and for lines that end with PostNL, Hermes or La Poste. Get the same quote from 2–3 agents and send 10–20 test parcels. |
| NL 3PL | Quotes from Monta, Zunapro and Omnipack. Air freight for 2–4 weeks of stock; once it lands, the delivery promise becomes 1–3 days. |
| Automation | [LLM] Supplier match and automatic cost (1688 image search, Haiku check, CJ freight): 1–2 days, $6–20/month. [data sources] The CJ API for cost and shipping is on this week's list. |

On the board, the 🚀 Launch checklist from [#26] has a Sourcing step (supplier link, unit cost, shipping, MOQ, lead time, sample ordered) and a Margin step (VAT 21% and payment fees 3% unless you enter your own).

## Questions to ask suppliers

Questions 1–3 weren't captured.

| # | Ask for |
|---|---|
| 4 | Lead time for each quantity |
| 5 | Packed weight and size, units per carton, carton size and weight |
| 6 | Logo or packaging MOQ and cost |
| 7 | CE/RoHS/REACH report number, lab and applicant |
| 8 | For batteries: UN38.3 summary, safety data sheet, capacity in Wh |
| 9 | Defect policy |
| 10 | Whether they ship to your agent or dropship single parcels, and how fast after payment |
| 11 | Whether the sample equals bulk production, and whether the sample fee is credited on a bulk order |
| 12 | Exclusive design or private mould, and the mould fee |
| 13 | Factory or trader, and monthly capacity |
| 14 | An unedited video showing today's date and your name, or a short video call |

## EU customs and VAT (2026)

The detailed rules weren't captured. These references survive in the plan and the checklist:

| Item | What to do or check |
|---|---|
| IOSS | Confirm it is active (D0). First orders ship on a tracked, duties-paid line under your IOSS (D5). |
| Each shipping line | Get written confirmation of how it bills the €3 + €2 (what the amounts are for wasn't captured), that it uses your IOSS, declares your real sale price and sends product identifiers |
| OSS/IOSS in Shopify | Set up the store with your accountant |
| Stock imported into NL | The Article 23 licence, EORI number and customs broker fees; the tariff code and duty rate for the product |
| CJ stock in Germany | Whether it needs German VAT registration |
| Germany | Whether a representative is required; the LUCID update by 12 Nov |
| France | The representative rule |
| Italy | The €2 fee, if you expand there |
| Product page | Delivery time per country, the China-dispatch notice, an NL return address, and the GPSR details |

Other EU rules the research flagged:
- [LLM] Under the EU product safety regulation, you are the importer of your 1688 goods.
- [LLM] The new Product Liability Directive applies to products sold after 9 Dec 2026. No model can check a certificate.
- [data sources] The EU responsible-person rule; VAT or GST inside the margin; the rules per market already in `worker/src/market-rules.mjs`.
- [data sources] Payments: Visa's 1.5% limit on fraud plus disputes, Shopify holding back part of your payouts, and frozen funds from Schedule A lawsuits.

## Seven-day plan: approved product to first shipped order

| Day | Do |
|---|---|
| D0 | Shortlist 5–8 listings and run the listing checks (not captured), with a licence check on the top 3. Send the first message. Ask the agent for QC options, 0.5/1 kg express quotes, and lines that end with PostNL, Hermes or La Poste. Check whether CJ stocks the product in Frankfurt. Buy a competitor's unit locally. Draft the product page with delivery time per country, the China-dispatch notice and an NL return address. Confirm IOSS is active. |
| D1 | Order 1–2 samples from the top two suppliers through the agent, paid on 1688. Optionally send 20–50 units to the agent's warehouse as starter stock. Put the page live with its GPSR details and start a small ad test. |
| D2–3 | Suppliers dispatch to the agent. Run the sample test on the competitor's unit to set the quality bar. |
| D4 | The agent's detailed QC (photos, function video, measurements) is the go/no-go. Express the winning sample to NL. |
| D5 | First customer orders ship from the agent's stock on a tracked, duties-paid line under your IOSS. Negotiate price tiers and the sample-fee credit. Book air freight for 2–4 weeks of stock to the NL 3PL, with an inspection if over about 100 units (adds 2–3 days). |
| D6–7 | The physical sample arrives; run the full test. If it fails, pause ads and switch to the second supplier. |
| D8–12 | Stock lands at the NL 3PL. Switch fulfilment and change the delivery promise to 1–3 days. |

**Plan for 10–14 days in practice.** Singles' Day on 11 November will congest Chinese parcels, and battery products need 1–3 extra days for their safety documents.

## Check by hand before paying

- Line prices for 300 g / 500 g / 1 kg to NL/DE/FR, and which local carrier each line uses: get the same quote from 2–3 agents and send 10–20 test parcels.
- Written confirmation of how each line bills the €3 + €2, that it uses your IOSS, declares your real sale price and sends product identifiers.
- CJ's EU stock and fees per product, and whether stock in Germany needs German VAT registration.
- The Shopify OSS/IOSS store set-up, with your accountant.
- Quotes from Monta, Zunapro and Omnipack; the Article 23 licence, EORI number and customs broker fees; the tariff code and duty rate for the product.
- Your actual Shopify Payments rates and any reserve on the account.
- Germany: whether a representative is required, and the LUCID update by 12 Nov. France: the representative rule.
- That the supplier's test reports are genuine.
- Insurance cover in writing.
- Trademark and design clearance for the product and your brand.
- Italy's €2 fee, if you expand there.

## Offered, not built

The session offered to add a landed-cost check to the board, next to each 1688 link: "€5 per product type, packed weight, battery flag, CJ Frankfurt stock". The LLM research's landed-cost gate (its #2) covers similar ground.

[#26]: https://github.com/hopmanecommerce-png/winner-hunter/pull/26
