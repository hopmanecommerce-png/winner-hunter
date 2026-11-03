# Sourcing

How to choose a supplier for a product, with evidence, and the products already run through it. Quality and fast delivery come first, price after.

| File | What's in it |
|---|---|
| [supplier-selection.md](supplier-selection.md) | **The method, for every product:** the steps, the hard gates, the scoring model (7 criteria, weights you can change, what each score means, ties), the sample protocol, the first message to suppliers in English and Chinese, red flags, the decision record and the re-check every 90 days and before every reorder |
| [showerhead-muravai.md](showerhead-muravai.md) | **The first product:** Muravai's filtered showerhead. What matters for this category, the five sourcing routes compared for NL/DE and the US, the shortlist, which supplier to choose now and the backup, the refill cartridge and what a subscription leaves next to Muravai's $19.99 every 28 days, the EU and US rules (parcel duty and handling fee, CE, RoHS, REACH, GPSR, drinking-water materials, what an ad may claim in NL and DE), and Connor's next steps |

## On the board

**🚀 Launch → 🏭 Suppliers**: one scorecard per product, saved in D1 (table `sourcing`, migrations `0060_sourcing.sql` and `0061_sourcing_showerhead_update.sql`). Start one from a launch card's Sourcing step, or for any product by name. A scorecard compares up to 5 suppliers side by side and shows the weighted score and the gates. **Choose** records the decision with its numbers and a backup. The showerhead's scorecard is seeded with its sample tests and questions, and no suppliers: those come from your own shortlist.

Code: `winner-hunter/worker/src/supplier.mjs` (the scoring, also run by the board as `/supplier.js`). Tests: `winner-hunter/test/supplier.test.mjs` and `supplier.e2e.test.mjs`.

## Related

- [../learnings/sourcing-and-shipping.md](../learnings/sourcing-and-shipping.md): the earlier research on routes, EU customs and VAT, and the 7-day plan from an approved product to the first shipped order.
- The 🚀 Launch view's Sourcing and Margin steps take the chosen supplier's numbers through 🔎 Sourcing, below.
- **🔎 Sourcing** on a launch card (`worker/src/sourcing.mjs`, tables `product_suppliers` and `product_sourcing`) is where the 1688 links are pasted and compared on landed cost. The two work as one:
  - 🔎's **🏭 Score them side by side** opens the product's scorecard.
  - Its candidates show in the scorecard under "In 🔎 Sourcing, not here yet", one tap each, with prices in euros.
  - **Choose** in 🏭 chooses the same supplier in 🔎 (it adds it there first when 🔎 doesn't have it). Its numbers then reach `product_sourcing`, the 💶 € view and the launch card's Sourcing step.
  - Taking the decision back in 🏭 clears 🔎's choice only when 🏭 made it.
