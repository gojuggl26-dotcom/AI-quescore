import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quescore',
  description: 'Decentralized survey quality scoring on 0G Network',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
