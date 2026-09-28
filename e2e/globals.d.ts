// The demo recorder hook installed by the app (src/ui/components/chrome.tsx).
interface Window {
  __caption?: (text: string) => void;
}
