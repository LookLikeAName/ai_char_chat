// avatar 傳照片的方式：自己入鏡、用代替的東西（例如娃娃）入鏡、或不入鏡；參考圖；照片風格；試拍一張
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  IMAGE_STYLE_LABELS,
  imageModelSupportsReference,
  PHOTO_APPEARS,
  PHOTO_APPEARS_LABELS,
  PHOTO_REFERENCE_LABELS,
  PHOTO_REFERENCES,
  type AvatarDto,
  type AvatarPhoto,
  type ImageStyle,
} from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { prepareImage } from '../lib/images.ts';
import { errorText, useToast } from '../lib/toast.tsx';
import { Icon } from './Icon.tsx';

function sampleScene(p: AvatarPhoto): string {
  if (p.appears === 'self') return '在房間的窗邊，對著鏡頭比耶的自拍';
  if (p.appears === 'proxy') return `${p.proxy || '玩偶'}坐在窗邊，旁邊有一杯熱茶`;
  return '桌上的一杯熱茶和一本翻開的書，午後的陽光';
}

export function PhotoSettingsCard({
  avatar,
  value,
  onChange,
}: {
  avatar: AvatarDto | null;
  value: AvatarPhoto;
  onChange: (v: AvatarPhoto) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const { data: profiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const [scene, setScene] = useState<string | null>(null);
  const [sample, setSample] = useState<string | null>(null);
  const patch = (p: Partial<AvatarPhoto>) => onChange({ ...value, ...p });

  const gen = settings?.imageGen;
  const genProfile = profiles.find((p) => p.id === gen?.profileId);
  const canReference = gen && genProfile ? imageModelSupportsReference(genProfile.provider, gen.model) : true;
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.avatars });

  const upload = useMutation({
    mutationFn: async (file: File) => api.uploadPhotoReference(avatar!.id, await prepareImage(file)),
    onSuccess: refresh,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.deletePhotoReference(avatar!.id),
    onSuccess: refresh,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const test = useMutation({
    mutationFn: () => api.testPhoto(avatar!.id, scene ?? sampleScene(value), value),
    onSuccess: (r) => setSample(r.url),
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <section className="card">
      <h2>照片</h2>
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>會傳照片給你</span>
      </label>
      {(!gen || !settings?.photos.enabled) && (
        <p className="hint">
          {!gen ? '還沒有選圖片模型' : '傳照片目前在全域關掉了'}，到 <Link to="/settings/general">設定 → 一般 → 頭像與照片生成</Link> 設定。
        </p>
      )}

      {value.enabled && (
        <>
          <fieldset className="field radio-group">
            <legend className="field-label">在照片裡怎麼出現</legend>
            {PHOTO_APPEARS.map((a) => (
              <label key={a} className="check">
                <input type="radio" name="photo-appears" checked={value.appears === a} onChange={() => patch({ appears: a })} />
                <span>{PHOTO_APPEARS_LABELS[a]}</span>
              </label>
            ))}
            {value.appears === 'proxy' && (
              <input
                value={value.proxy}
                maxLength={200}
                placeholder="代替自己入鏡的東西，例如：一隻白色的長耳兔玩偶，脖子上綁著紅色緞帶"
                onChange={(e) => patch({ proxy: e.target.value })}
                aria-label="代替自己入鏡的東西"
              />
            )}
          </fieldset>

          <label className="field">
            <span className="field-label">參考圖</span>
            <select value={value.reference} onChange={(e) => patch({ reference: e.target.value as AvatarPhoto['reference'] })}>
              {PHOTO_REFERENCES.map((r) => (
                <option key={r} value={r}>
                  {PHOTO_REFERENCE_LABELS[r]}
                </option>
              ))}
            </select>
            <span className="hint">
              {value.appears === 'none'
                ? '自己不入鏡時通常不需要參考圖。'
                : `參考圖讓${value.appears === 'proxy' ? '代替的東西' : '入鏡的人'}每張照片都長得一樣。頭像不是本人的樣子（例如用了風景或寵物當頭像）時，選「不用」或另外上傳一張。`}
              {!canReference && ' 目前的圖片模型不支援參考圖（Gemini 的圖片模型與 gpt-image 才支援），會只照文字描述拍。'}
            </span>
          </label>
          {value.reference === 'avatar' && avatar && !avatar.imageUrl && <p className="hint">還沒有頭像，會只照文字描述拍。</p>}
          {value.reference === 'custom' &&
            (avatar ? (
              <div className="avatar-row">
                {avatar.photoReferenceUrl ? (
                  <img className="reference-thumb" src={avatar.photoReferenceUrl} alt="照片的參考圖" />
                ) : (
                  <span className="reference-thumb empty">還沒上傳</span>
                )}
                <div className="avatar-row-actions">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload.mutate(f);
                      e.target.value = '';
                    }}
                  />
                  <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                    <Icon name="image" size={16} /> {upload.isPending ? '上傳中…' : '上傳參考圖'}
                  </button>
                  {avatar.photoReferenceUrl && (
                    <button type="button" className="btn btn-ghost" onClick={() => remove.mutate()}>
                      移除
                    </button>
                  )}
                  <span className="hint">只用來拍照片，不會當成頭像。</span>
                </div>
              </div>
            ) : (
              <p className="hint">建立後就可以上傳參考圖。</p>
            ))}

          <label className="field">
            <span className="field-label">照片風格</span>
            <select
              value={value.style ?? ''}
              onChange={(e) => patch({ style: (e.target.value || null) as ImageStyle | null })}
            >
              <option value="">跟全域設定（{settings ? IMAGE_STYLE_LABELS[settings.photos.style] : '…'}）</option>
              {Object.entries(IMAGE_STYLE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {avatar && gen && (
            <details className="image-gen">
              <summary>試拍一張</summary>
              <label className="field">
                <span className="field-label">照片內容</span>
                <input value={scene ?? sampleScene(value)} onChange={(e) => setScene(e.target.value)} maxLength={500} />
                <span className="hint">用上面的設定（還沒儲存也可以）拍一張看看，不會傳到聊天裡。每次都要付圖片模型的費用。</span>
              </label>
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? '拍攝中…' : '試拍'}
                </button>
              </div>
              {sample && <img className="photo-sample" src={sample} alt="試拍的照片" />}
            </details>
          )}
        </>
      )}
    </section>
  );
}
