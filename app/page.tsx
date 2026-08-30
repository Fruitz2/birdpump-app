import "./landing.css";
import { LandingClient } from "@/components/landing/LandingClient";
import { FAQ_ITEMS } from "@/components/landing/faq-data";

export const dynamic = "force-dynamic";

// FAQPage structured data — mirrors the on-page FAQ section (same source
// module), so search engines see exactly what visitors see.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a }
  }))
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <LandingClient />
    </>
  );
}
