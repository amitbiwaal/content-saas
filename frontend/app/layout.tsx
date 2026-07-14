import type { Metadata } from "next";
import "./globals.css";
import { LanguageProvider } from "../lib/i18n";

export const metadata: Metadata = {
  title: "ContentOS AI",
  description:
    "Multi-model AI content engine — council debate, judge, publish gate.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The pre-hydration script below sets html lang/dir (and data-theme) before
    // React hydrates, so those attributes intentionally differ from the server
    // render — suppress the (expected) hydration warning for this element.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');var l=localStorage.getItem('lang');if(l){document.documentElement.lang=l;document.documentElement.dir=(l==='ar'||l==='he')?'rtl':'ltr';}}catch(e){}",
          }}
        />
        <div className="fx-particles" aria-hidden="true" />
        <LanguageProvider>{children}</LanguageProvider>
      </body>
    </html>
  );
}
