// The rules for selling into each market outside the EU, shown under that country on the board. General research, not
// legal advice. Source: research/2026-10-31-market-rules in the product-research repo (README.md and extra-countries.md have the
// detail and every source). Each item says how far it was checked: fact, estimate or unverified. Check again before relying on one.
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
    },
    "SG": {
      "short": "GST 9%, register above S$1M global + S$100k SG. To S$400 by air: no GST at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "GST 9%. Overseas sellers register above S$1M global and S$100,000 Singapore consumer sales a year. No local agent mentioned.",
          "status": "fact",
          "source": "https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-and-digital-economy/overseas-businesses",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Air up to S$400 with freight and insurance: GST relief. Post not clearly stated. Duty only on liquor, tobacco, cars, petrol.",
          "status": "fact",
          "source": "https://customs.gov.sg/businesses/customs-schemes-licences-framework/iras-schemes/overseas-vendor-registration-regime/",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "SAFETY Mark on controlled goods, incl. AC adaptors and plugs. Extra rules for toys, childcare items and power banks.",
          "status": "fact",
          "source": "https://www.consumerproductsafety.gov.sg/about/faqs/for-suppliers/",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Cosmetics: label details in English, with the party placing them on the market. No general language rule found.",
          "status": "fact",
          "source": "https://www.hsa.gov.sg/cosmetic-products/overview/",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Specific medical claims can make a product a medical device: licence, usually registration. Advertiser is responsible.",
          "status": "fact",
          "source": "https://www.hsa.gov.sg/medical-devices/regulatory-overview",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Defect within 6 months presumed present at delivery. Repair or replace, then price cut or refund. Not for change of mind.",
          "status": "fact",
          "source": "https://www.meti.gov.sg/resources/laws-and-regulations/general-advisory-on-amendments-to-the-consumer-protection-fair-trading-act-and-hire-purchase-act",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Mandatory charges belong in the headline price. Discounts and strikethroughs must be genuine. Applies online.",
          "status": "fact",
          "source": "https://www.ccs.gov.sg/consumer-protection/legislation-and-guidelines/guidelines-on-price-transparency/",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "One party in the chain must register controlled goods. Portal uses ACRA company data; local entity implied, not stated.",
          "status": "unverified",
          "source": "https://www.consumerproductsafety.gov.sg/about/faqs/for-suppliers/",
          "checked": "2026-10-31"
        }
      ]
    },
    "JE": {
      "short": "GST 5%, register above £300k. Under £60 with shipping: usually nothing at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "GST 5%. Overseas retailers register above £300,000 Jersey sales in 12 months. No local representative mentioned.",
          "status": "fact",
          "source": "https://www.gov.je/TaxesMoney/GST/Businesses/Industry/Pages/OverseasRetailersGST.aspx",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Personal parcels under £60 with shipping usually pay no GST or duty. From £60: 5% GST, paid before delivery.",
          "status": "fact",
          "source": "https://www.jerseypost.com/letters-and-parcels/receiving/customs-when-receiving/",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Distributors and producers answer for the safety of goods. Trading Standards can issue safety notices.",
          "status": "fact",
          "source": "https://gov.je/Industry/BusinessAdviceHub/TradeSell/Pages/SellingRules.aspx",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Falsely claiming a product cures illness, dysfunction or malformation is banned outright.",
          "status": "fact",
          "source": "https://www.gov.je/StayingSafe/ConsumerProtection/ShoppersRights/Pages/UnfairCommercialPractices.aspx",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Cancel up to 7 working days after delivery, refund within 30 days. Law text names no rule for sellers outside Jersey.",
          "status": "fact",
          "source": "https://www.jerseylaw.je/laws/current/l_37_2007",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Bait pricing and false time-limited offers are banned. Price with all taxes and delivery cost must be given before sale.",
          "status": "fact",
          "source": "https://www.gov.je/StayingSafe/ConsumerProtection/ShoppersRights/Pages/UnfairCommercialPractices.aspx",
          "checked": "2026-10-31"
        }
      ]
    },
    "HK": {
      "short": "No VAT, no tariff on ordinary goods: nothing to register for or pay at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "No value added or general services tax, so nothing to register for.",
          "status": "fact",
          "source": "https://www.customs.gov.hk/en/service-enforcement-information/cargo-clearance/index.html",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "No customs tariff, quota or surcharge on imports of ordinary goods.",
          "status": "fact",
          "source": "https://www.customs.gov.hk/en/service-enforcement-information/cargo-clearance/index.html",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Makers, importers and suppliers must keep goods reasonably safe. Toys and listed child goods have set standards.",
          "status": "fact",
          "source": "https://www.cedb.gov.hk/en/policies/consumer-protection.html",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Cautionary notices on packs or labels must be in English and Chinese. Also for toys and listed child goods.",
          "status": "fact",
          "source": "https://www.cedb.gov.hk/en/policies/consumer-protection.html",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Ads can't claim a medicine, surgical appliance or treatment cures or prevents scheduled diseases. Schedule not read.",
          "status": "fact",
          "source": "https://www.cmro.gov.hk/files/en/whats_new/letter_trader/2012/Commencement_of_the_Undesirable_Medical_Advertisements_Amendment_Ordinance_2005_Eng.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Government's 2020 answer: no statutory cooling-off for online shopping, none planned. Nothing newer checked.",
          "status": "fact",
          "source": "https://www.info.gov.hk/gia/general/202006/03/P2020060300290.htm",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "False descriptions, misleading omissions, bait advertising and wrongly taking payment are banned practices.",
          "status": "fact",
          "source": "https://www.cedb.gov.hk/en/policies/consumer-protection.html",
          "checked": "2026-10-31"
        }
      ]
    },
    "MO": {
      "short": "No VAT and no duty on ordinary goods (PwC, secondary). Postal fee not confirmed.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "No VAT regime, so nothing to register for. PwC, secondary; no official tax page opened.",
          "status": "fact",
          "source": "https://taxsummaries.pwc.com/macau-sar/corporate/other-taxes",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "No duty except tobacco and spirits (PwC). Macau Post: recipient shows any permit required by law. No fee stated.",
          "status": "fact",
          "source": "https://www.ctt.gov.mo/MacauPost/Contents/Prohibited.aspx?lang=en-us",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Right to goods meeting health and safety criteria. No approval scheme found. Gazette would not load; law firm note.",
          "status": "unverified",
          "source": "https://conventuslaw.com/report/china-protection-of-consumer-rights-and-interests/",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Info in Chinese and Portuguese, or Chinese and English if imported. Gazette would not load; law firm note.",
          "status": "unverified",
          "source": "https://conventuslaw.com/report/china-protection-of-consumer-rights-and-interests/",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "7-day cancel on distance sales, 1 year on defects, only if the seller operates in Macau. Gazette would not load; IFLR 2021.",
          "status": "unverified",
          "source": "https://www.iflr.com/article/2a63733ixysbvclr1awj9/new-regime-for-the-protection-of-consumer-rights-and-interests-in-macau-sar",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Price and payment terms are required information. No discount rule found. Gazette would not load; law firm note.",
          "status": "unverified",
          "source": "https://conventuslaw.com/report/china-protection-of-consumer-rights-and-interests/",
          "checked": "2026-10-31"
        }
      ]
    },
    "JP": {
      "short": "Consumption tax 10%. Customs value to ¥10,000: no duty or tax at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "Consumption tax 10%. ¥10M is the general threshold. Whether a seller shipping from abroad must register: not confirmed.",
          "status": "fact",
          "source": "https://www.nta.go.jp/english/taxes/consumption_tax/01.htm",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Customs value of ¥10,000 or less: no duty or consumption tax. How that value is worked out: not checked.",
          "status": "fact",
          "source": "https://www.customs.go.jp/english/c-answer_e/imtsukan/1006_e.htm",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "PSE on listed electrical goods, incl. mobile batteries. Child PSC mark on baby beds and baby toys.",
          "status": "fact",
          "source": "https://www.meti.go.jp/policy/consumer/seian/shouan/contents/guideline_en.pdf",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Quality labels under the Household Goods Act for textiles, plastics, electrics and others. Japanese wording not confirmed.",
          "status": "fact",
          "source": "https://www.japaneselawtranslation.go.jp/en/laws/view/3935",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "PMD Act Art. 68 bars advertising the efficacy of a device without approval. Which goods count: not checked. Law firm note.",
          "status": "fact",
          "source": "https://monolith.law/en/general-corporate/medical-supplies-law",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Buyer can cancel within 8 days of delivery and pays return post, unless the ad shows other return terms.",
          "status": "fact",
          "source": "https://www.no-trouble.caa.go.jp/what/mailorder/",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "A comparison price that is false, vague or not recently charged can mislead. Mail-order price must show shipping.",
          "status": "fact",
          "source": "https://www.caa.go.jp/policies/policy/representation/fair_labeling/representation_regulation/double_price",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Selling covered goods direct: notify, and appoint a domestic administrator in Japan. In force 25 Dec 2025 (METI).",
          "status": "fact",
          "source": "https://www.meti.go.jp/policy/consumer/seian/shouan/contents/guideline_en.pdf",
          "checked": "2026-10-31"
        }
      ]
    },
    "KR": {
      "short": "VAT 10%. Personal goods to $150 with shipping: no duty or VAT. Buyer gives a code.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "VAT 10% (PwC, secondary). Seller registration for goods shipped from abroad: not found.",
          "status": "fact",
          "source": "https://taxsummaries.pwc.com/republic-of-korea/corporate/other-taxes",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Personal goods up to $150 with shipping: no duty or VAT. Buyer must give a personal clearance code.",
          "status": "fact",
          "source": "https://www.customs.go.kr/english/cm/cntnts/cntntsView.do?mi=8058&cntntsId=2734",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "KC mark run by KATS. 2024 ban on uncertified direct imports scrapped; 80 item types checked instead. Current state not read.",
          "status": "fact",
          "source": "https://www.kedglobal.com/newsView/ked202405190002",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Commercial shipments need origin marks and Korean labels (US guide, 2026). Direct-to-buyer case not addressed.",
          "status": "fact",
          "source": "https://www.trade.gov/country-commercial-guides/south-korea-labelingmarking-requirements",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Advertising a general product as having medical-device effect: up to 3 years or KRW 30M (news, Jul 2026).",
          "status": "fact",
          "source": "https://en.nocutnews.co.kr/news/6544035",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "E-Commerce Act: full refund if withdrawn within 7 days (news on a 2026 court case). Foreign store reach not confirmed.",
          "status": "fact",
          "source": "https://mbiz.heraldcorp.com/article/10811430",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "KFTC fined Temu KRW 358M in 2025 over a false countdown and unclear free offers. False-discount rule text not found.",
          "status": "fact",
          "source": "https://www.legal500.com/intelligence/south-korea/media-telecoms-it-entertainment/kftc-sanctions-temu-for-violations-of-advertising-and-e-commerce-regulations",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Domestic agent from 21 Jan 2027: KRW 1tn sales, 1M users or KFTC request. Draft figures; final decree not read.",
          "status": "unverified",
          "source": "https://www.hwawoo.com/eng/insights/newsletter/2658",
          "checked": "2026-10-31"
        }
      ]
    },
    "MY": {
      "short": "Sales tax 10%, register above RM500k. Air courier to RM500: exempt at the door.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "Low-value goods tax 10%. Sellers inside or outside Malaysia register above RM500,000 in 12 months. No rep mentioned.",
          "status": "fact",
          "source": "https://mylvg.customs.gov.my/FAQ",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Air courier parcel up to RM500 with shipping keeps its duty and tax exemption. Postal route not confirmed.",
          "status": "fact",
          "source": "https://mylvg.customs.gov.my/FAQ",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Listed electrical goods need Energy Commission approval with a lab test report, and the ST-SIRIM label.",
          "status": "fact",
          "source": "https://www.st.gov.my/how-do-i-apply-certificate-approval-coa",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Act 737 sets registration of medical devices. Where beauty, pain or posture goods fall: not found.",
          "status": "fact",
          "source": "https://portal.mda.gov.my/introduction/background.html",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Consumer Protection Act has covered electronic trade since 2007. Online cooling-off not found. Law firm note, 2022.",
          "status": "fact",
          "source": "https://mahwengkwai.com/e-commerce-laws-regulations-malaysia/",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Online sellers must show total price with transport and tax, plus business details. Law firm note, 2022.",
          "status": "fact",
          "source": "https://mahwengkwai.com/e-commerce-laws-regulations-malaysia/",
          "checked": "2026-10-31"
        }
      ]
    },
    "TW": {
      "short": "Tax 5%. Customs value to NT$2,000: no duty or tax. China-goods limit unresolved.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "Import business tax 5%. Seller registration rule for physical goods: not found.",
          "status": "fact",
          "source": "https://www.etax.nat.gov.tw/etwmain/tax-info/network-transaction-taxtation-area/seller/import-notice",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Customs value to NT$2,000: no duty or tax. After 6 exempt parcels in a half year, the exemption stops for that buyer.",
          "status": "fact",
          "source": "https://www.etax.nat.gov.tw/etwmain/tax-info/network-transaction-taxtation-area/consumer/oversea-online-shopping-notice",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Listed goods must pass BSMI inspection before entry. Parcels of listed goods follow those rules too.",
          "status": "fact",
          "source": "https://www.trade.gov/country-commercial-guides/taiwan-standards-trade",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Imported goods need labels and instructions in Mandarin, no less complete than at origin (Art. 24).",
          "status": "fact",
          "source": "https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0170001",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Non-devices can't promote therapeutic effects (Art. 46). Fine NT$600,000 to NT$25M (Art. 65).",
          "status": "fact",
          "source": "https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=L0030106",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Distance sales: return within 7 days of receipt, no reason needed; some exceptions. Foreign seller reach not confirmed.",
          "status": "fact",
          "source": "https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0170001",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "False or misleading ads on price are banned (Fair Trade Act Art. 21).",
          "status": "fact",
          "source": "https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0150002",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Australia Post lists mainland China goods as banned by post. MOEA rule returned 403, so scope is unknown.",
          "status": "unverified",
          "source": "https://auspost.com.au/sending/parcels-overseas/international-post-guide/results/taiwan",
          "checked": "2026-10-31"
        }
      ]
    },
    "IL": {
      "short": "VAT 18%. To $75: no VAT or duty at the door (news; gov.il blocked). Hebrew labels.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "VAT 18% (PwC, secondary). Seller registration for goods from abroad not found. gov.il returned 403.",
          "status": "unverified",
          "source": "https://taxsummaries.pwc.com/israel/corporate/other-taxes",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Tax-free limit back to $75 after Knesset vote, 2 Jun 2026 (news). gov.il returned 403; some guides still say $150.",
          "status": "unverified",
          "source": "https://www.timesofisrael.com/knesset-revokes-smotrichs-order-expanding-personal-import-tax-exemption-to-130/amp/",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "Some standards mandatory. High-risk electrical goods and toys need Israeli lab tests. Direct-to-buyer not addressed.",
          "status": "fact",
          "source": "https://www.trade.gov/country-commercial-guides/israel-trade-standards",
          "checked": "2026-10-31"
        },
        {
          "k": "labels",
          "label": "Labels",
          "text": "Goods marking must be in Hebrew unless rules say otherwise (s.17(c), law text on Wikisource).",
          "status": "fact",
          "source": "https://he.wikisource.org/wiki/%D7%97%D7%95%D7%A7_%D7%94%D7%92%D7%A0%D7%AA_%D7%94%D7%A6%D7%A8%D7%9B%D7%9F",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Misleading on a product's use, benefit or risks is banned, also in ads (s.2). Medical device law not read.",
          "status": "fact",
          "source": "https://he.wikisource.org/wiki/%D7%97%D7%95%D7%A7_%D7%94%D7%92%D7%A0%D7%AA_%D7%94%D7%A6%D7%A8%D7%9B%D7%9F",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "Distance sale: cancel within 14 days of receipt. Fee up to 5% or NIS 100, the lower. Foreign seller reach not confirmed.",
          "status": "fact",
          "source": "https://he.wikisource.org/wiki/%D7%97%D7%95%D7%A7_%D7%94%D7%92%D7%A0%D7%AA_%D7%94%D7%A6%D7%A8%D7%9B%D7%9F",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Goods and ads show only the total price with VAT, in shekels (s.17B, 17D). Misleading on usual price is banned (s.2).",
          "status": "fact",
          "source": "https://he.wikisource.org/wiki/%D7%97%D7%95%D7%A7_%D7%94%D7%92%D7%A0%D7%AA_%D7%94%D7%A6%D7%A8%D7%9B%D7%9F",
          "checked": "2026-10-31"
        },
        {
          "k": "blocker",
          "label": "Blocker",
          "text": "Imports must show an Israeli importer's name (US guide). Direct-to-buyer not addressed; gov.il returned 403.",
          "status": "unverified",
          "source": "https://trade.gov/country-commercial-guides/israel-labelingmarking-requirements",
          "checked": "2026-10-31"
        }
      ]
    },
    "LI": {
      "short": "VAT 8.1%. Swiss duties apply. Swiss door rule assumed: about CHF 62 before charges.",
      "items": [
        {
          "k": "tax",
          "label": "Tax",
          "text": "VAT 8.1%, Swiss VAT law, exempt below CHF 100,000 domestic turnover (PwC, secondary). Tax rep rule not confirmed.",
          "status": "fact",
          "source": "https://taxsummaries.pwc.com/liechtenstein/corporate/other-taxes",
          "checked": "2026-10-31"
        },
        {
          "k": "customs",
          "label": "Customs",
          "text": "Customs union: Swiss duties apply (PwC). My inference: Swiss CHF 5 tax rule too, so about CHF 62 is free at the door.",
          "status": "estimate",
          "source": "https://taxsummaries.pwc.com/liechtenstein/corporate/other-taxes",
          "checked": "2026-10-31"
        },
        {
          "k": "safety",
          "label": "Safety",
          "text": "EEA and Swiss rules run in parallel: goods can be sold under either. Goods barred in Switzerland can't pass on there.",
          "status": "fact",
          "source": "https://llv.li/en/business/safety-protection/market-monitoring/fmd-market-surveillance-and-control-system-",
          "checked": "2026-10-31"
        },
        {
          "k": "claims",
          "label": "Claims",
          "text": "Medical devices not fit for Switzerland: duty to warn and keep files 5 years. Claim rules for ordinary goods not found.",
          "status": "fact",
          "source": "https://www.llv.li/en/business/industry-professional-associations/health-professions-and-therapeutic-products/medical-devices/market-access",
          "checked": "2026-10-31"
        },
        {
          "k": "returns",
          "label": "Returns",
          "text": "KSchG (Mar 2026) names distance sales; warranty law dated Dec 2025. Distance withdrawal text not found, so term unknown.",
          "status": "unverified",
          "source": "https://www.gesetze.li/konso/pdf/2002164000",
          "checked": "2026-10-31"
        },
        {
          "k": "pricing",
          "label": "Pricing",
          "text": "Before binding, trader gives total price with taxes and delivery (KSchG Art. 7a). Distance cover and discount rule not found.",
          "status": "fact",
          "source": "https://www.gesetze.li/konso/pdf/2002164000",
          "checked": "2026-10-31"
        }
      ]
    }
  }
};
