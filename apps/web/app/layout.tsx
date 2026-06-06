import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Monitoramento Facial",
  description: "Dashboard local de monitoramento facial"
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}

