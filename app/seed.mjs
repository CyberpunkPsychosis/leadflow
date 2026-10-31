// Fictional demo leads used to show the pipeline end to end.
// Deliberately messy: different field names, budget formats and sources.

export const SEED_LEADS = [
  {
    source: 'website_form',
    name: 'Sarah Mitchell',
    email: 'sarah.mitchell@brightline-logistics.com',
    phone: '(415) 555-0137',
    company: 'Brightline Logistics',
    budget: '$15k-25k',
    timeline: 'next month',
    message:
      'We get inbound freight quotes through three regional websites plus a phone line. Everything is triaged by hand in a shared inbox and we lose deals because first replies take 6-8 hours. Looking for someone to automate intake, scoring and routing to the right rep, and push it into HubSpot. Can you share a proposal and timeline?',
    utm: { source: 'google', medium: 'cpc', campaign: 'logistics-automation' },
  },
  {
    source: 'whatsapp',
    name: 'Diego Alvarez',
    email: 'diego@casaverdestudio.mx',
    company: 'Casa Verde Studio',
    budget: '3k',
    timeline: 'ASAP',
    message:
      'Hola, I run a small design studio and need an AI assistant that answers client inquiries on WhatsApp and books calls. What would it cost and how fast can you start?',
  },
  {
    source: 'facebook_ads',
    name: 'Tom Becker',
    email: 'tbecker@beckerroofing.com',
    company: 'Becker Roofing',
    message: 'How much for a simple chatbot for my website? Just looking for a ballpark.',
  },
  {
    source: 'linkedin',
    name: 'Nisha Rao',
    email: 'n.rao@zenwellhealth.com',
    company: 'Zenwell Health',
    budget: 'USD 40,000',
    timeline: 'Q1',
    message:
      'We are evaluating vendors for a patient intake automation project across 12 clinics. Scope: HIPAA-aware intake, eligibility checks, and CRM sync. We have a budget approved and a procurement deadline at the end of the quarter. Sending our RFP if you can sign an NDA.',
  },
  {
    source: 'landing_page',
    name: 'Karen Wu',
    email: 'karen.wu@student.example.edu',
    message: 'I am a student and need help with a class project about CRM. Can someone help me for free?',
  },
  {
    source: 'website_form',
    name: 'SEO Express',
    email: 'offers@seo-express.biz',
    message:
      'Hi, we offer SEO services and guaranteed traffic. We can place guest posts on DA50+ sites and buy backlinks at wholesale prices. Reply for a catalog.',
  },
  {
    source: 'referral',
    name: 'Marcus Bell',
    email: 'marcus@fieldstonebuilt.com',
    phone: '+1 512 555 0191',
    company: 'Fieldstone Construction',
    budget: '8,000',
    timeline: 'within 6 weeks',
    message:
      'Our project managers still track bids in spreadsheets. We want leads from the site form to be scored and routed, synced to Buildertrend, and a follow-up sequence over email. We already use n8n for a few small jobs. What would you need from us to start?',
  },
  {
    source: 'linkedin',
    name: 'Lena Fischer',
    email: 'lena@nordlicht-media.de',
    company: 'Nordlicht Media',
    budget: '€5k',
    timeline: 'this quarter',
    message:
      'We are a 12-person marketing agency. Interested in integrating HubSpot with an AI qualification layer for our inbound leads. Is this something you have done before?',
  },
  {
    source: 'website_chat',
    name: 'Priya Shah',
    email: 'priya@loomandthread.co',
    company: 'Loom & Thread',
    budget: '1200',
    timeline: 'next week',
    message:
      'We sell handmade textiles on Shopify. Customers ask the same 20 questions about shipping and sizing. Can you build a chat widget that answers from our product pages? Budget is tight.',
  },
  {
    source: 'website_form',
    name: 'Andre Silva',
    email: 'andre.silva@proton.me',
    message: 'Just researching CRM automation for now. No project yet, thanks.',
  },
];
