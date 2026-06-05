import { INDUSTRIES } from './App.jsx';
import { Icons } from './components/Icons.jsx';
import { Header } from './components/Header.jsx';

const INDUSTRY_ICONS = {
  'mortgage': Icons.building,
  'public-sector': Icons.landmark,
  'consumer-credit': Icons.creditCard,
  'retail-banking': Icons.wallet,
  'coverage-analysis': Icons.barChart,
};

function IndustryCard({ industry, index }) {
  const demoCount = industry.demos.length;
  const Icon = INDUSTRY_ICONS[industry.id];
  return (
    <a
      href={`#${industry.id}`}
      class="group block animate-slideUp"
      style={{ animationDelay: `${80 + index * 60}ms` }}
    >
      <div class="border border-transparent rounded-2xl px-6 py-5 transition-all duration-300 hover:bg-[#f5f5f7] active:scale-[0.99]">
        <div class="flex items-start gap-4">
          <div class="w-10 h-10 rounded-xl bg-[#f5f5f7] border border-[#e8e8ed] flex items-center justify-center text-[#8E8E93] shrink-0 group-hover:border-primary/30 group-hover:bg-primary/5 group-hover:text-primary transition-all">
            {Icon && <Icon size={20} />}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-[17px] font-semibold tracking-[-0.02em] text-[#171717] group-hover:text-primary transition-colors">{industry.name}</h3>
              <svg class="w-4 h-4 text-[#8E8E93] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
            </div>
            <p class="text-[15px] text-[#8E8E93] leading-[1.5] mb-2">{industry.desc}</p>
            <span class="text-[12px] font-medium text-[#8E8E93]">{demoCount} {demoCount === 1 ? 'demo' : 'demos'}</span>
          </div>
        </div>
      </div>
    </a>
  );
}

export function Home() {
  return (
    <div class="min-h-screen flex flex-col bg-white">
      <Header badge="Demo Apps" sticky />
      <main class="flex-1 flex items-start justify-center pt-16 pb-20 px-6">
        <div class="max-w-[640px] w-full">
          <div class="animate-slideUp mb-12">
            <h1 class="text-[40px] font-semibold tracking-[-0.03em] text-[#171717] leading-[1.1] mb-3">Truv Demo Apps</h1>
            <p class="text-[17px] text-[#8E8E93] leading-[1.5] max-w-[480px]">
              See how Truv helps verify income, employment, and assets across mortgage, consumer lending, government, and banking.
            </p>
          </div>

          {/* LION POS — case study prototype */}
          <div class="mb-6 -mx-6 px-6">
            <a href="#lion" class="group block rounded-2xl border border-[#1a3a5c]/20 bg-[#1a3a5c]/5 hover:bg-[#1a3a5c]/10 px-6 py-5 transition-all duration-200">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-10 h-10 rounded-xl bg-[#1a3a5c] flex items-center justify-center shrink-0">
                    <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div>
                    <div class="flex items-center gap-2 mb-0.5">
                      <h3 class="text-[17px] font-semibold text-[#1a3a5c] tracking-[-0.02em]">LION POS</h3>
                      <span class="text-[10px] font-semibold bg-[#1a3a5c] text-white px-2 py-0.5 rounded tracking-wide uppercase">Case Study</span>
                    </div>
                    <p class="text-[14px] text-[#4a6fa5]">Loan officer intake form with embedded Bridge verification and BSS billing simulation.</p>
                  </div>
                </div>
                <svg class="w-4 h-4 text-[#1a3a5c] opacity-50 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200 shrink-0 ml-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </a>
          </div>

          <div class="-mx-6">
            {INDUSTRIES.filter(i => i.demos.length > 0).map((ind, i) => (
              <IndustryCard key={ind.id} industry={ind} index={i} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
