// 上傳前在瀏覽器縮圖：長邊最多 1600px、轉成 JPEG，手機拍的大照片也能很快傳完，送給模型也省 token。
// GIF 保留原檔（才會動）；已經夠小的 PNG／WebP 也不動。
const MAX_SIDE = 1600;
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_BYTES = 800 * 1024;

export async function prepareImage(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('只能傳 PNG、JPEG、WebP、GIF 圖片');
  if (file.type === 'image/gif') {
    if (file.size > MAX_BYTES) throw new Error('GIF 不能超過 5 MB');
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= KEEP_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d')!;
  // 透明的地方填白，轉 JPEG 才不會變黑
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('無法處理這張圖片');
  if (blob.size > MAX_BYTES) throw new Error('圖片太大了');
  return blob;
}
