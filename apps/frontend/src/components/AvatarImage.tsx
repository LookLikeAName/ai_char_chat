// 頭像：有圖片就顯示圖片，沒有就用名字第一個字 + 依名字決定的底色
const HUES = [345, 20, 45, 150, 190, 220, 265, 300];

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return HUES[h % HUES.length]!;
}

export function AvatarImage({ name, src, size = 40 }: { name: string; src: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.42 };
  if (src) return <img className="avatar-img" src={src} alt="" style={style} />;
  const hue = hueOf(name);
  return (
    <span
      className="avatar-img avatar-fallback"
      style={{ ...style, background: `oklch(0.72 0.11 ${hue})` }}
      aria-hidden
    >
      {[...name.trim()][0] ?? '?'}
    </span>
  );
}
