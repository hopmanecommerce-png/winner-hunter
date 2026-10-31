// The rules for selling into each market outside the EU, shown under that country on the board. General research, not
// legal advice. Source: research/2026-10-31-market-rules in the product-research repo (README.md has the detail and every
// source). Each item says how far it was checked: fact, estimate or unverified. Check again before relying on one.
export const MARKET_RULES = {
  "as_of": "2026-10-31",
  "note": "General research, not legal advice.",
  "markets": {
    "AU": {
      "short": "GST 10%, register at A$75k. No duty or GST at the door up to A$1,000.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "GST 10%. Foreign seller registers at A$75,000 a year, then charges it. ATO page blocked; secondary source only.",
          "status": "unverified",
          "source": "https://trykintsugi.com/sales-tax-guides/apac/australia",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Up to A$1,000 (about €629): no duty, tax or charges for most goods. Buyer pays nothing on a €25–90 order.",
          "status": "fact",
          "source": "https://www.abf.gov.au/imports/Pages/How-to-import/Import-declarations.aspx",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Small strong magnets in toys are banned. Button-battery goods need secure compartments. Full ACCC list page blocked.",
          "status": "fact",
          "source": "https://www.nsw.gov.au/legal-and-justice/consumer-rights-and-protection/safety/childrens-products-and-toy-safety/magnets-and-button-batteries-childrens-toys",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "English. Care labels mandatory on clothing and household textiles. ACCC page blocked; test-lab summary read.",
          "status": "unverified",
          "source": "https://intertek.com/products-retail/insight-bulletins/2023/australia-update-care-labelling-regulation",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Therapeutic claims can require an ARTG entry before import or supply. TGA page timed out; law-firm source read.",
          "status": "unverified",
          "source": "https://www.claytonutz.com/insights/2024/november/tga-enforcement-actions-rise-as-court-orders-the-biggest-therapeutic-goods-act-penalty-yet",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Guarantees on quality, fitness and description apply, including to overseas businesses. Change of mind: see README.",
          "status": "fact",
          "source": "https://www.nsw.gov.au/legal-and-justice/consumer-rights-and-protection/shopping/consumer-rights-when-buying-a-product",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Total price must include GST and fixed fees. Delivery that varies by weight or distance shows before the last step.",
          "status": "fact",
          "source": "https://www.consumerprotection.wa.gov.au/consumer-protection/multiple-pricing",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Mains goods: EESS supplier must be an AU/NZ entity; overseas firms can't register. Phone-type chargers are in scope.",
          "status": "fact",
          "source": "https://www.eess.gov.au/responsible-supplier/manufacturers-and-importers-responsible-suppliers/",
          "checked": "2026-10-31"
        }
      ]
    },
    "CA": {
      "short": "Over CAD 20 buyer pays GST/HST, duty and fee. Seller abroad doesn't collect GST/HST.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "Seller shipping from abroad, no stock in Canada: no GST/HST to collect. Buyer owes GST 5% or HST 13–15% at the border.",
          "status": "fact",
          "source": "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/charge-collect/sales-good.html",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "China goods: duty and tax free only up to CAD 20 (about €13). So every €25–90 order owes duty and tax at the border.",
          "status": "fact",
          "source": "https://www.cbsa-asfc.gc.ca/services/cusma-aceum/lvs-efv-eng.html",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Goods that endanger health or safety are banned for importers and sellers. Records and incident reports required.",
          "status": "fact",
          "source": "https://www.canada.ca/en/health-canada/services/consumer-product-safety/legislation-guidelines/acts-regulations/canada-consumer-product-safety-act.html",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Textiles: fibre content in English and French, plus name and address. CA numbers are for Canadian firms only.",
          "status": "fact",
          "source": "https://competition-bureau.canada.ca/en/labelling/textile-labelling/labelling-textile-requirements-nutshell",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "A device that treats or prevents a condition is a medical device. A seller abroad then needs an MDEL, even for Class I.",
          "status": "fact",
          "source": "https://www.canada.ca/en/health-canada/services/drugs-health-products/compliance-enforcement/establishment-licences/annual-review-documents/frequently-asked-questions-medical-device-establishment-licensing-fees.html",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Quebec: cancel if not delivered in 30 days or key info is missing. No general change-of-mind right is listed.",
          "status": "fact",
          "source": "https://www.opc.gouv.qc.ca/en/consumer/topic/purchase/online-purchase/cancelling/",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Drip pricing banned: the price must include fixed fees. Only charges government puts on buyers are exempt.",
          "status": "fact",
          "source": "https://competition-bureau.canada.ca/en/deceptive-marketing-practices/drip-pricing",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Quebec: site and labels in French; OQLF can bar sales. Reach to foreign sellers from a law firm only, OQLF not opened.",
          "status": "unverified",
          "source": "https://www.lwlaw.com/quebecs-bill-96-new-language-obligations-for-businesses-in-quebec/",
          "checked": "2026-10-31"
        }
      ]
    },
    "NZ": {
      "short": "GST 15%, register at NZ$60k. Goods to NZ$1,000: nothing to pay at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "GST 15%. Register once NZ sales reach NZ$60,000 in 12 months; delivery fees count. No tax agent mentioned.",
          "status": "fact",
          "source": "https://www.ird.govt.nz/gst/gst-for-overseas-businesses/gst-on-low-value-imported-goods/registering-for-gst-on-low-value-imported-goods",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Border GST and duty start above NZ$1,000. Below: levy NZ$2.21 + GST per air consignment, on whoever lodges the clearance.",
          "status": "fact",
          "source": "https://www.customs.govt.nz/media/utdnkqm0/quick-reference-guide-all-goods-levies-from-1-april-2026.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "15 listed items, incl. small magnets, inclined infant sleepers, children's nightwear, cots, hot water bottles.",
          "status": "fact",
          "source": "https://www.comcom.govt.nz/business/your-obligations-as-a-business/product-safety-standards/",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Care labels mandatory on new clothing, bedding and household fabrics, whether made here or overseas.",
          "status": "fact",
          "source": "https://comcom.govt.nz/fair-trading/consumer-information-standards/care-labelling",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "A claimed or implied therapeutic purpose, also in ads, brings a product under the Medicines Act.",
          "status": "fact",
          "source": "https://www.medsafe.govt.nz/regulatory/devicesnew/1Definition.asp",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "NZ consumer law covers all businesses offering goods to NZ buyers. Change of mind is not protected.",
          "status": "fact",
          "source": "https://www.consumerprotection.govt.nz/general-help/ways-to-buy-and-pay/online-shopping/know-your-rights-when-shopping-online",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Was-prices must reflect recent real prices. Extra charges can't hide in fine print.",
          "status": "fact",
          "source": "https://comcom.govt.nz/business/pricing-your-products-or-services",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Electronics: conformity declaration signed by an NZ supplier or NZ agent of an overseas seller (RSM guide, undated).",
          "status": "fact",
          "source": "https://www.rsm.govt.nz/assets/Uploads/documents/compliance-guide.pdf",
          "checked": "2026-10-31"
        }
      ]
    },
    "NO": {
      "short": "VAT 25%. VOEC collects it at checkout, no door fee. No VOEC: VAT + NOK 46/78 at door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "VAT 25%. VOEC by NOK 50,000 (about €4,850) a year; may start before first sale. No Norwegian rep mentioned.",
          "status": "fact",
          "source": "https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "VOEC, each item under NOK 3,000: no duty or fee. Without VOEC: VAT, any duty, Posten NOK 46 or 78 (about €4.50–7.60).",
          "status": "fact",
          "source": "https://www.posten.no/fortolling/motta-fra-utlandet",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "EU GPSR not yet in EEA law per europalov; regjeringen.no blocked. CE needed on toys and electrics. Batteries Reg also out.",
          "status": "unverified",
          "source": "https://europalov.no/rettsakt/produktsikkerhetsforordningen-2023-gjennomforingsbestemmelser-om-produktsikkerhetsportalen-safety/id-32466",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Textile fibre labelling under EU 1007/2011 applies via a 2012 Norwegian regulation. Language not stated on this page.",
          "status": "fact",
          "source": "https://lovdata.no/dokument/SF/forskrift/2012-10-25-990/KAPITTEL_1",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Devices: no claims of functions or uses they don't have (MDR Art. 7). Other claims fall under general marketing law.",
          "status": "fact",
          "source": "https://www.dmp.no/en/medical-devices/sale-import-and-distribution/advertising-for-medical-devices",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "14 days to withdraw, plus 12 months if the seller gave no withdrawal info. Reach to sellers abroad not confirmed.",
          "status": "fact",
          "source": "https://lovdata.no/dokument/NL/lov/2014-06-20-27",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Before-price must be the lowest price used in at least the prior 30 days. Applies to goods.",
          "status": "fact",
          "source": "https://www.forbrukertilsynet.no/vi-jobber-med/prismarkedsforing/salg-og-bruk-av-forpriser",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "VOEC number must reach the carrier digitally, or buyer can pay VAT twice. Whether agent lines do this is not checked.",
          "status": "fact",
          "source": "https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/sending-goods-under-the-voec-scheme/",
          "checked": "2026-10-31"
        }
      ]
    },
    "CH": {
      "short": "VAT 8.1%. Free at door to about CHF 62; above that VAT plus Post CHF 16 + 3%.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "VAT 8.1%. Register at CHF 100,000 a year in small parcels (about €108,800). Foreign firms then need a Swiss tax rep.",
          "status": "fact",
          "source": "https://www.estv.admin.ch/en/vat-mail-order-trade-and-platform-taxation",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "To about CHF 62 (€67) nothing due. Above: 8.1% VAT + Post CHF 16 + 3%, max CHF 70, paid by buyer. Duty 0%.",
          "status": "estimate",
          "source": "https://www.post.ch/en/receiving-mail/import-customs-clearance",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Online shops selling in CH must meet PrSG; warnings in local official language. EU GPSR itself doesn't apply there.",
          "status": "fact",
          "source": "https://www.seco.admin.ch/de/faq-produktesicherheit",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Textile fibre and care labels not mandatory. If used: one national language; care symbols need a free licence.",
          "status": "fact",
          "source": "https://swisstextiles.ch/en/issues/new-service-how-to-label-textiles-correctly",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Medical device: foreign makers appoint a Swiss rep (CH-REP); importer must be named. Ad rules: see README.",
          "status": "fact",
          "source": "https://www.swissmedic.ch/dam/swissmedic/en/dokumente/medizinprodukte/mep_urr/mu600_00_016d_mb_pflichten_wirtschaftsakteure_ch.pdf.download.pdf/MU600_00_016e_MB_Obligations_Economic_Operators_CH.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "No statutory return right for online orders. Buyer has 2 years of warranty claims. Reach to sellers abroad unchecked.",
          "status": "fact",
          "source": "https://www.kmu.admin.ch/de/die-gesetze-der-schweiz-und-der-eu",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Price in CHF incl. VAT and surcharges; shipping shown apart. Was-price needs real prior sale (30 days or half-time rule).",
          "status": "fact",
          "source": "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/1978/2081_2081_2081/20250101/de/pdf-a/fedlex-data-admin-ch-eli-cc-1978-2081_2081_2081-20250101-de-pdf-a.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "No outright stop found. Advance disposal fee law reaches foreign online sellers since 2025, per a BAFU legal opinion.",
          "status": "fact",
          "source": "https://www.bafu.admin.ch/dam/it/sd-web/X9NZ0nVOWdDV/gutachten-betreffend-das-verursacherprinzip-im-bereich-problematischer-stoffe.pdf",
          "checked": "2026-10-31"
        }
      ]
    },
    "AE": {
      "short": "VAT 5% at import, importer pays. Dubai duty-free to AED 1,000. Courier fees extra.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "Named importer owes 5% import VAT. Goods imported first, then sold, count as a local sale; non-residents have a nil threshold.",
          "status": "fact",
          "source": "https://tax.gov.ae/DownloadOpenTextFile?fileUrl=en%2FVAT_VAT_Guides%2FE_Commerce%2FE_Commerce_VAT+Guide_EN_09_08_2020_EN.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Dubai: goods to AED 1,000 (about €244) exempt from duty; in effect 3 Aug 2026 per press. Other emirates not checked.",
          "status": "fact",
          "source": "https://www.dubaicustoms.gov.ae/en/PoliciesAndNotices/Notices/CN16_2026.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "ECAS sheet lists low-voltage goods, textiles, baby care, cosmetics. Applicant needs a UAE trade licence. Sheet from 2022.",
          "status": "fact",
          "source": "https://moiat.gov.ae/-/media/site/moiat/document/services-user-manual/cad-regulated-sheet.ashx",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Info and ads in Arabic, or Arabic plus another language. Legislation portal blocked; law-firm source read.",
          "status": "unverified",
          "source": "https://www.klgates.com/Update-UAE-Consumer-Protection-and-E-Commerce-Laws-1-23-2024",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "No medical product ad without market authorisation and regulator review. Law-firm guide from May 2024; MOHAP failed to load.",
          "status": "unverified",
          "source": "https://cms.law/en/int/expert-guides/cms-expert-guide-to-advertising-of-medicines-and-medical-devices/united-arab-emirates",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Return or exchange right exists; law reaches goods from abroad under conditions. Time limit not confirmed; portal blocked.",
          "status": "unverified",
          "source": "https://www.klgates.com/Update-UAE-Consumer-Protection-and-E-Commerce-Laws-1-23-2024",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Discounts need a licence; one law firm says the consumer law disclaims sellers abroad. Portal blocked, not settled.",
          "status": "unverified",
          "source": "https://cms.law/en/are/legal-updates/the-uae-s-new-consumer-protection-landscape-implications-and-key-provisions",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Bluetooth or Wi-Fi goods: supplier must register with TDRA before selling. TDRA not opened; test-lab source read.",
          "status": "unverified",
          "source": "https://www.tuv.com/market-access-services/en/certification-filter/united-arab-emirates-telecommunication-apparatus-(tdra)-approval.html",
          "checked": "2026-10-31"
        }
      ]
    },
    "US": {
      "short": "No de minimis. China goods owe about 12.5–50% duty, plus fees. No VAT, sales tax later.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "No federal VAT. State sales tax mostly at $100,000 a state, $500,000 in CA, NY, TX. State sites not opened.",
          "status": "unverified",
          "source": "https://www.salestaxinstitute.com/resources/economic-nexus-state-guide",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Every parcel owes duty: MFN + Section 301 (0, 7.5 or 25%) + 12.5%. Estimate 12.5–50%. Rate depends on the HTS code.",
          "status": "estimate",
          "source": "https://ustr.gov/sites/default/files/files/Press/Releases/2026/FLIP%20301%20Investigation%20Final%20Action%20FRN%207-23-26%20FINAL.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "CPSC certificates and eFiling only if a rule covers the product; no low-value exemption. Children's goods need a CPC.",
          "status": "fact",
          "source": "https://www.cpsc.gov/FAQ/eFiling-Frequently-Asked-Questions-FAQ",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Textiles incl. bedding and towels: fibre, origin and maker ID. Separate rule: every import marked with origin in English.",
          "status": "fact",
          "source": "https://www.ftc.gov/business-guidance/resources/threading-your-way-through-labeling-requirements-under-textile-wool-acts",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Health claims need proof before you make them. Claims to treat a condition can make it an FDA medical device.",
          "status": "fact",
          "source": "https://www.ftc.gov/business-guidance/advertising-marketing/health-claims",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "No federal right to return described. Ship within the stated time, or 30 days if none is stated. State law can add rights.",
          "status": "fact",
          "source": "https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "California: price must include mandatory fees; shipping and government tax excepted. FTC bars fake former prices.",
          "status": "fact",
          "source": "https://oag.ca.gov/hiddenfees",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "FCC supplier declaration (SDoC) needs a responsible party located in the US. Affects electronics using that route.",
          "status": "fact",
          "source": "https://www.law.cornell.edu/cfr/text/47/2.1077",
          "checked": "2026-10-31"
        }
      ]
    }
  }
};
