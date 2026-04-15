"use client";

import { useAuth } from "@/components/auth/auth-provider";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Image from "next/image";
import { trackSignInInitiated } from "@/lib/analytics";

// Apple and Yahoo sign-in are temporarily disabled on the landing page.
// The providers are still wired in auth-provider.tsx for when we re-enable them.
// import { signInWithApple, signInWithYahoo } from "...";

const MCP_SERVER_URL =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:8080";

export default function SignInPage() {
  const { user, loading, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  const GoogleIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );

  const SignInButton = ({
    size = "md",
    label = "Continue with Google",
  }: {
    size?: "sm" | "md" | "lg";
    label?: string;
  }) => {
    const sizes = {
      sm: "px-4 py-2 text-sm gap-2 rounded-xl",
      md: "px-5 py-3 text-[15px] gap-2.5 rounded-2xl",
      lg: "px-7 py-4 text-base gap-3 rounded-2xl",
    };
    return (
      <button
        onClick={() => {
          trackSignInInitiated("google");
          void signInWithGoogle();
        }}
        className={`inline-flex items-center justify-center ${sizes[size]} bg-surface-lowest font-semibold text-on-surface shadow-soft ring-1 ring-black/5 transition-all hover:shadow-ambient hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]`}
      >
        <GoogleIcon className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
        {label}
      </button>
    );
  };

  const features = [
    {
      title: "Agent-first planning",
      body: "Paste a group chat, drop a link, or just describe your trip. Our agent reads it and builds the whole itinerary — stops, routes, timing — on the map.",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="m12 3 1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 18.5 6 21l2.5-1M19 16l-.7 2.4L16 18" />
        </svg>
      ),
    },
    {
      title: "A path for every traveler",
      body: "Some friends hike, some drive to the vineyard, everyone meets for dinner. Give each person their own route — the app keeps track of who's where, all trip long.",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="12" r="2.5" />
          <path strokeLinecap="round" d="M8.2 7.3 15.5 11M8.2 16.7 15.5 13" />
        </svg>
      ),
    },
    {
      title: "Map and timeline, one tap",
      body: "Flip between a live map and a zoomable timeline. Separate lanes when the group splits, time zones handled for you.",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25M15.5 17.75l4.87-2.44c.39-.19.63-.58.63-1.01V4.82c0-.84-.88-1.38-1.63-1.01l-3.87 1.94c-.32.16-.7.16-1.01 0L9.5 3.25c-.32-.16-.7-.16-1.01 0L3.63 5.69C3.24 5.88 3 6.27 3 6.7v9.49c0 .84.88 1.38 1.63 1.01l3.87-1.94c.32-.16.7-.16 1.01 0l4.99 2.49Z" />
        </svg>
      ),
    },
    {
      title: "Plan from your favorite AI app",
      body: "Already chatting with Claude, ChatGPT, or Cursor? Paste in a personal access key and plan, browse, or edit your trip right from there.",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path strokeLinecap="round" d="M8 20h8M12 16v4M7 9l2 2-2 2M12 13h4" />
        </svg>
      ),
    },
    {
      title: "Real-time crew",
      body: "Invite links, live participant pulse on the map, notifications when the plan changes. No more 'wait, which hotel are we at?'",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <circle cx="12" cy="8" r="3.2" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 20c.8-3.5 3.8-5.5 7.5-5.5s6.7 2 7.5 5.5" />
        </svg>
      ),
    },
    {
      title: "Works in the mountains",
      body: "Offline-aware editing, optimistic updates, optional location sharing. Designed for the parts of a trip where LTE disappears.",
      icon: (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-6 w-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="m3 18 5-8 3.5 5 2.5-3.5L21 18H3Z" />
          <circle cx="17" cy="6" r="2" />
        </svg>
      ),
    },
  ];

  const steps = [
    {
      n: "01",
      title: "Chat it into existence",
      body: "Describe your trip, paste your group chat, or drop in a handful of links. The app turns it into a first draft in seconds.",
    },
    {
      n: "02",
      title: "Watch it build your map",
      body: "The AI drops pins, picks routes, and stitches the trip together step by step, right before your eyes.",
    },
    {
      n: "03",
      title: "Invite your crew",
      body: "Share an invite link, decide who goes where, and let everyone edit the plan together in real time.",
    },
    {
      n: "04",
      title: "Keep planning anywhere",
      body: "Use the app on the go — or keep planning from inside the AI apps you already use, like Claude, ChatGPT, or Cursor.",
    },
  ];

  const faqs = [
    {
      q: "Can I plan from ChatGPT, Claude, or Cursor?",
      a: "Yes. Travel Buddy speaks MCP — an open standard that lets AI apps talk to tools. Paste a personal access key into your AI app's settings and it can read, build, and edit your trips using the same account you use here. No copy-pasting between apps.",
    },
    {
      q: "Do I have to use the AI to plan my trip?",
      a: "Not at all. The map is a fast, tap-friendly editor — add stops, drag things around, edit times. The AI is there when you want it (to build a first draft, to research a place, to make a change from your laptop) but the app is designed to feel great without it too.",
    },
    {
      q: "How do splits and merges work?",
      a: "Your trip is a set of stops connected by travel. Every stop has a list of people on it. When two of you leave the same city and meet up again later, that's a split and a merge — the timeline shows parallel lanes and the map shows parallel routes, so no one loses track of who's where.",
    },
    {
      q: "Is my data private?",
      a: "Your trips live in your account. We don't train on your plans, and location sharing is fully opt-in per person — turn it off and no location data is written, ever.",
    },
    {
      q: "How much does it cost?",
      a: "Free during early access. Sign in, build a trip, and tell us what you think.",
    },
  ];

  // -----------------------------------------------------------------------

  return (
    <div className="min-h-screen overflow-x-clip bg-surface text-on-surface">
      {/* ============ TOP NAV ============ */}
      <header className="fixed top-0 inset-x-0 z-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-4">
          <div className="glass-panel flex items-center justify-between rounded-2xl px-4 py-2.5 shadow-soft ring-1 ring-black/5">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-xl gradient-primary grid place-items-center shadow-soft">
                <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} stroke="currentColor" className="h-4 w-4 text-on-primary">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.5 3.5 4.88-2.44c.38-.19.62-.58.62-1V4.82c0-.84-.88-1.38-1.63-1.01l-3.87 1.94c-.32.16-.69.16-1.01 0L9.5 3.25c-.32-.16-.69-.16-1 0L3.62 5.69C3.24 5.88 3 6.27 3 6.7v12.48c0 .84.88 1.38 1.63 1.01l3.87-1.94c.32-.16.69-.16 1 0l5 2.5c.32.16.69.16 1 0Z" />
                </svg>
              </div>
              <span className="font-bold tracking-tight">Travel Buddy</span>
              <span className="hidden sm:inline-block text-[10px] font-semibold uppercase tracking-wider text-tertiary bg-tertiary-container/60 rounded-full px-2 py-0.5 ml-1">
                Early access
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="#features"
                className="hidden md:inline-block text-sm font-medium text-on-surface-variant hover:text-on-surface px-3 py-1.5"
              >
                Features
              </a>
              <a
                href="#mcp"
                className="hidden md:inline-block text-sm font-medium text-on-surface-variant hover:text-on-surface px-3 py-1.5"
              >
                MCP
              </a>
              <a
                href="#faq"
                className="hidden md:inline-block text-sm font-medium text-on-surface-variant hover:text-on-surface px-3 py-1.5"
              >
                FAQ
              </a>
              <SignInButton size="sm" label="Sign in" />
            </div>
          </div>
        </div>
      </header>

      {/* ============ HERO ============ */}
      <section className="relative gradient-warm pt-32 pb-20 lg:pt-40 lg:pb-28 overflow-hidden">
        <div className="landing-grid-bg absolute inset-0" aria-hidden />
        <div
          className="sunset-orb absolute -top-20 -left-20 w-[420px] h-[420px] animate-float-slow"
          aria-hidden
        />
        <div
          className="sunset-orb absolute top-40 right-0 w-[320px] h-[320px] animate-float-slow"
          style={{ animationDelay: "1.5s" }}
          aria-hidden
        />

        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center animate-fade-up">
            <div className="inline-flex items-center gap-2 rounded-full bg-surface-lowest/70 backdrop-blur px-4 py-1.5 text-xs font-semibold text-on-surface-variant ring-1 ring-black/5 shadow-soft">
              <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
              AI-first · Plan on the go · Built for humans
            </div>
            <h1 className="mt-6 text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.02]">
              Your next trip, in{" "}
              <span className="gradient-warm-text">every AI app</span> you already use.
            </h1>
            <p className="mt-6 text-lg sm:text-xl text-on-surface-variant leading-relaxed max-w-2xl mx-auto">
              Smart Travel Buddy is a collaborative trip planner for your phone.
              Chat your itinerary into existence, give every traveler their own
              path, and keep your plans in sync whether you're in the app or
              chatting with ChatGPT, Claude, or Cursor.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
              <SignInButton size="lg" label="Continue with Google" />
              <a
                href="#how"
                className="text-sm font-semibold text-on-surface-variant hover:text-on-surface px-5 py-4"
              >
                See how it works →
              </a>
            </div>
            <p className="mt-4 text-xs text-on-surface-variant">
              Free during early access · No credit card · 30 seconds to your first trip
            </p>
          </div>

          {/* Hero visual — phone mockup with Italy trip */}
          <div
            className="relative mt-16 lg:mt-20 mx-auto max-w-xl animate-fade-up"
            style={{ animationDelay: "0.15s" }}
          >
            <div className="absolute -inset-8 sunset-orb -z-10" aria-hidden />
            <PhoneFrame>
              <Image
                src="/landing/phone-hero.png"
                alt="Smart Travel Buddy on a phone — Italian road trip from Ljubljana to Rome"
                width={900}
                height={1950}
                priority
                className="block h-full w-full object-cover"
              />
            </PhoneFrame>
            {/* Floating badges */}
            <div className="hidden lg:block absolute -left-4 top-20 glass-panel-dense rounded-2xl px-4 py-3 shadow-float ring-1 ring-black/5 animate-float-slow">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-secondary-container grid place-items-center">
                  <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-4 w-4 text-secondary">
                    <path strokeLinecap="round" d="m5 13 4 4L19 7" />
                  </svg>
                </div>
                <div className="text-left">
                  <div className="text-xs text-on-surface-variant">Agent added</div>
                  <div className="text-sm font-semibold">6 stops · 5 legs</div>
                </div>
              </div>
            </div>
            <div
              className="hidden lg:block absolute -right-4 bottom-24 glass-panel-dense rounded-2xl px-4 py-3 shadow-float ring-1 ring-black/5 animate-float-slow"
              style={{ animationDelay: "1s" }}
            >
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg gradient-primary grid place-items-center">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-on-primary">
                    <path d="M12 2 3 7v6c0 5 3.8 9.7 9 11 5.2-1.3 9-6 9-11V7l-9-5Z" />
                  </svg>
                </div>
                <div className="text-left">
                  <div className="text-xs text-on-surface-variant">Planning from</div>
                  <div className="text-sm font-semibold">Claude · live</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ AGENT + MCP SHOWCASE ============ */}
      <section id="mcp" className="relative py-24 lg:py-32 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto">
            <div className="inline-block text-xs font-semibold uppercase tracking-widest text-primary mb-3">
              AI-first · Works with Claude, ChatGPT, Cursor
            </div>
            <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
              Plan from wherever <br className="hidden sm:block" />
              you <span className="gradient-warm-text">already chat</span>.
            </h2>
            <p className="mt-5 text-lg text-on-surface-variant">
              Most trip apps bolt a chatbot on the side. We built the opposite —
              an AI helper at the heart of everything, with the app as just one
              of several ways to talk to it.
            </p>
          </div>

          <div className="mt-16 grid lg:grid-cols-5 gap-8 items-start">
            {/* Left: chat preview */}
            <div className="lg:col-span-3 min-w-0 rounded-3xl bg-surface-lowest shadow-float ring-1 ring-black/5 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-surface-high bg-surface-low">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-lg gradient-primary grid place-items-center">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 text-on-primary">
                      <path d="m12 2 1.9 4.8L18.7 8.7l-4.8 1.9L12 15.4l-1.9-4.8L5.3 8.7l4.8-1.9L12 2Z" />
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-semibold">Trip Agent</div>
                    <div className="text-[11px] text-on-surface-variant">Italian Road Trip — Nov 2026</div>
                  </div>
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-secondary bg-secondary-container/70 rounded-full px-2 py-0.5">
                  Live
                </span>
              </div>
              <div className="p-5 space-y-3 text-sm">
                <ChatBubble role="user">
                  We land in Ljubljana Nov 7, drive down through Venice, Parma,
                  Florence, end in Rome Nov 14. Two of us, splitting a car.
                </ChatBubble>
                <ChatBubble role="agent">
                  Got it. I'll sketch the route: Ljubljana → Venice → Parma →
                  Florence → Rome. Want me to add a rest day somewhere, or keep
                  it moving?
                </ChatBubble>
                <ChatBubble role="user">
                  Rest day in Florence. And find a hotel near the old town.
                </ChatBubble>
                <ChatBubble role="agent">
                  Added Florence (2 nights). Booked a placeholder at Hotel
                  Duomo — swap it any time.
                  <ToolCallLine name="add stop" args="Florence · 2 nights" />
                  <ToolCallLine name="add stop" args="Hotel Duomo · near old town" />
                  <ToolCallLine name="add travel" args="Venice → Parma · drive" />
                </ChatBubble>
              </div>
            </div>

            {/* Right: MCP .mcp.json */}
            <div className="lg:col-span-2 min-w-0">
              <div className="rounded-3xl bg-inverse-surface text-inverse-on-surface shadow-float ring-1 ring-black/20 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
                  <div className="flex items-center gap-1.5">
                    <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                    <div className="h-2.5 w-2.5 rounded-full bg-yellow-300/70" />
                    <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
                  </div>
                  <div className="text-[11px] font-mono text-white/60">.mcp.json</div>
                  <div className="w-12" />
                </div>
                <pre className="p-4 text-[12px] leading-relaxed font-mono overflow-x-auto">
{`{
  "mcpServers": {
    "smart-travel-buddy": {
      "type": "http",
      "url": "${MCP_SERVER_URL}/mcp",
      "headers": {
        "Authorization": "Bearer tb_live_•••"
      }
    }
  }
}`}
                </pre>
              </div>
              <p className="mt-5 text-xs text-on-surface-variant leading-relaxed">
                <span className="font-semibold text-on-surface">What is this?</span>{" "}
                A tiny snippet you paste into Claude, Cursor, or any AI app that
                supports MCP — the open standard for letting AI talk to tools.
                It lets your AI plan trips on your behalf, safely, using your own
                access key.
              </p>
              <ul className="mt-5 space-y-3 text-sm">
                <McpTool name="create a trip" desc="Start a new trip in seconds" />
                <McpTool name="add stops & travel" desc="Build the whole itinerary" />
                <McpTool name="find places" desc="Search restaurants, hotels, activities" />
                <McpTool name="read the trip" desc="Summarise the full plan to your AI" />
                <McpTool name="switch plans" desc="Try an alternate version, keep the old one" />
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ============ FEATURES GRID ============ */}
      <section id="features" className="relative py-24 lg:py-32 bg-gradient-to-b from-surface to-surface-low">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto">
            <div className="inline-block text-xs font-semibold uppercase tracking-widest text-primary mb-3">
              What's inside
            </div>
            <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
              Built for trips that{" "}
              <span className="gradient-warm-text">don't fit a list.</span>
            </h2>
            <p className="mt-5 text-lg text-on-surface-variant">
              Linear itineraries break the minute someone decides to split off.
              Travel Buddy doesn't.
            </p>
          </div>

          <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-3xl bg-surface-lowest p-7 shadow-soft ring-1 ring-black/5 transition-all hover:shadow-ambient hover:-translate-y-1"
              >
                <div className="h-12 w-12 rounded-2xl gradient-primary grid place-items-center text-on-primary shadow-soft group-hover:scale-105 transition-transform">
                  {f.icon}
                </div>
                <h3 className="mt-5 text-lg font-bold">{f.title}</h3>
                <p className="mt-2 text-sm text-on-surface-variant leading-relaxed">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how" className="relative py-24 lg:py-32 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto">
            <div className="inline-block text-xs font-semibold uppercase tracking-widest text-primary mb-3">
              How it works
            </div>
            <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
              From idea to itinerary in{" "}
              <span className="gradient-warm-text">four moves</span>.
            </h2>
          </div>

          <div className="mt-16 grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {steps.map((s, i) => (
              <div key={s.n} className="relative">
                <div className="rounded-3xl bg-surface-lowest p-7 shadow-soft ring-1 ring-black/5 h-full">
                  <div className="text-3xl font-bold gradient-warm-text">{s.n}</div>
                  <h3 className="mt-3 text-lg font-bold">{s.title}</h3>
                  <p className="mt-2 text-sm text-on-surface-variant leading-relaxed">
                    {s.body}
                  </p>
                </div>
                {i < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-1/2 -right-3 -translate-y-1/2 text-on-surface-variant/40">
                    →
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ SCREENSHOTS GALLERY ============ */}
      <section className="relative py-24 lg:py-32 bg-gradient-to-b from-surface-low to-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto">
            <div className="inline-block text-xs font-semibold uppercase tracking-widest text-primary mb-3">
              The app
            </div>
            <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
              A planner you actually{" "}
              <span className="gradient-warm-text">want to open</span>.
            </h2>
          </div>

          <div className="mt-16 grid sm:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-6 items-start">
            <div className="flex flex-col items-center">
              <PhoneFrame>
                <Image
                  src="/landing/phone-map.png"
                  alt="USA road trip with side trips through Yellowstone and Montana"
                  width={900}
                  height={1950}
                  className="block h-full w-full object-cover"
                />
              </PhoneFrame>
              <p className="mt-4 text-sm text-on-surface-variant text-center max-w-[260px]">
                Your whole trip on a live map — side trips, splits, travel modes.
              </p>
            </div>
            <div className="flex flex-col items-center">
              <PhoneFrame>
                <Image
                  src="/landing/phone-timeline.png"
                  alt="Vertical timeline showing stops in Missoula, Gardiner, Electric Peak Climb"
                  width={900}
                  height={1950}
                  className="block h-full w-full object-cover"
                />
              </PhoneFrame>
              <p className="mt-4 text-sm text-on-surface-variant text-center max-w-[260px]">
                A zoomable timeline that collapses quiet hours and handles time zones for you.
              </p>
            </div>
            <div className="flex flex-col items-center">
              <PhoneFrame>
                <Image
                  src="/landing/phone-home.png"
                  alt="Home screen showing your list of trips"
                  width={900}
                  height={1950}
                  className="block h-full w-full object-cover"
                />
              </PhoneFrame>
              <p className="mt-4 text-sm text-on-surface-variant text-center max-w-[260px]">
                All your trips in one place, ready to tap into.
              </p>
            </div>
            <div className="flex flex-col items-center">
              <PhoneFrame>
                <Image
                  src="/landing/phone-italy.png"
                  alt="Italian road trip map from Ljubljana to Rome"
                  width={900}
                  height={1950}
                  className="block h-full w-full object-cover"
                />
              </PhoneFrame>
              <p className="mt-4 text-sm text-on-surface-variant text-center max-w-[260px]">
                Sketched by the AI — Ljubljana → Venice → Parma → Florence → Rome.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section id="faq" className="relative py-24 lg:py-32 bg-surface">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="inline-block text-xs font-semibold uppercase tracking-widest text-primary mb-3">
              FAQ
            </div>
            <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
              Questions, <span className="gradient-warm-text">answered</span>.
            </h2>
          </div>

          <div className="mt-12 space-y-3">
            {faqs.map((f, i) => (
              <div
                key={f.q}
                className="rounded-2xl bg-surface-lowest shadow-soft ring-1 ring-black/5 overflow-hidden"
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between gap-4 px-6 py-5 text-left"
                >
                  <span className="font-semibold">{f.q}</span>
                  <span
                    className={`text-primary text-xl transition-transform duration-300 ${
                      openFaq === i ? "rotate-45" : ""
                    }`}
                  >
                    +
                  </span>
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-5 -mt-1 text-sm text-on-surface-variant leading-relaxed animate-fade-up">
                    {f.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ FINAL CTA ============ */}
      <section className="relative py-20 lg:py-28 gradient-warm overflow-hidden">
        <div
          className="sunset-orb absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px]"
          aria-hidden
        />
        <div className="relative mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Go plan something.
          </h2>
          <p className="mt-5 text-lg text-on-surface-variant">
            Sign in with Google, paste your group chat, and watch a trip assemble
            itself. Takes less than a minute.
          </p>
          <div className="mt-8 flex justify-center">
            <SignInButton size="lg" label="Continue with Google" />
          </div>
          <p className="mt-4 text-xs text-on-surface-variant">
            Free during early access · No credit card required
          </p>
        </div>
      </section>

      {/* ============ FOOTER ============ */}
      <footer className="py-10 bg-surface-low border-t border-surface-high">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-lg gradient-primary grid place-items-center">
              <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-3 w-3 text-on-primary">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25" />
              </svg>
            </div>
            <span className="text-sm font-semibold">Travel Buddy</span>
            <span className="text-xs text-on-surface-variant">
              · AI-first trip planning for the road
            </span>
          </div>
          <div className="text-xs text-on-surface-variant">
            © {new Date().getFullYear()} Smart Travel Buddy
          </div>
        </div>
      </footer>
    </div>
  );
}

/* =====================================================================
   Helpers
   ===================================================================== */

function BrowserFrame({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-surface-lowest shadow-float ring-1 ring-black/10 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-surface-high bg-surface-low">
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-300" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 min-w-0 text-center">
          <div className="inline-block rounded-md bg-surface px-3 py-0.5 text-[11px] font-mono text-on-surface-variant truncate max-w-full">
            {label}
          </div>
        </div>
        <div className="w-12" />
      </div>
      {children}
    </div>
  );
}

function PhoneFrame({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  // iPhone-style frame: rounded corners, dynamic-island hint, body shadow.
  // Content area uses a 9:19.5 aspect ratio (matches modern phones).
  return (
    <div
      className={`relative mx-auto w-full max-w-[300px] rounded-[2.75rem] bg-[#0b1414] p-[10px] shadow-float ring-1 ring-black/20 ${className}`}
    >
      <div className="relative overflow-hidden rounded-[2.1rem] bg-surface-lowest">
        {/* Dynamic island */}
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 h-[22px] w-[92px] -translate-x-1/2 rounded-full bg-[#0b1414]" />
        <div className="aspect-[9/19.5] w-full">{children}</div>
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  children,
}: {
  role: "user" | "agent";
  children: React.ReactNode;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary text-on-primary px-4 py-2.5 shadow-soft">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-surface-low px-4 py-2.5 ring-1 ring-black/5">
        {children}
      </div>
    </div>
  );
}

function ToolCallLine({ name, args }: { name: string; args: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] font-mono text-on-surface-variant">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-tertiary" />
      <span className="text-primary font-semibold">{name}</span>
      <span className="truncate">({args})</span>
    </div>
  );
}

function McpTool({ name, desc }: { name: string; desc: string }) {
  return (
    <li className="flex items-start gap-3">
      <div className="mt-1 h-1.5 w-1.5 rounded-full bg-tertiary flex-shrink-0" />
      <div>
        <code className="text-xs font-mono font-semibold text-primary">
          {name}
        </code>
        <span className="text-on-surface-variant"> — {desc}</span>
      </div>
    </li>
  );
}
