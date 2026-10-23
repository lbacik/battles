import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PÓLIS — scenario editor',
  description:
    'PÓLIS scenario library and battlefield editor: create a scenario, open its empty battlefield, save it, and reopen it after a reload.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
