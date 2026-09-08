import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { WatermarkSettings } from '@/core/utils/watermarkSettings';
import type { TranslationKey } from '@/utils/translations';

export function WatermarkSettingsCard({
  values,
  onChange,
  isVisible,
  t,
}: {
  values: WatermarkSettings;
  onChange: (kind: keyof WatermarkSettings, enabled: boolean) => void;
  isVisible: (settingId: string) => boolean;
  t: (key: TranslationKey) => string;
}) {
  const { download: watermarkDownloadEnabled, preview: watermarkPreviewEnabled } = values;
  return (
    <Card className="p-4 transition-all hover:shadow-md">
      <CardTitle className="mb-4">{t('nanobananaOptions')}</CardTitle>
      <CardContent className="space-y-4 p-0">
        <div hidden={!isVisible('download')} className="group flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-1.5">
              <Label
                htmlFor="watermark-download"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('nanobananaDownloadLabel')}
              </Label>
              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
                {t('nanobananaBadgeRecommended')}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">{t('nanobananaDownloadHint')}</p>
          </div>
          <Switch
            id="watermark-download"
            checked={watermarkDownloadEnabled}
            onChange={(e) => {
              onChange('download', e.target.checked);
            }}
          />
        </div>
        <div hidden={!isVisible('preview')} className="group flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-1.5">
              <Label
                htmlFor="watermark-preview"
                className="group-hover:text-primary cursor-pointer text-sm font-medium transition-colors"
              >
                {t('nanobananaPreviewLabel')}
              </Label>
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
                {t('nanobananaBadgeUnstable')}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">{t('nanobananaPreviewHint')}</p>
          </div>
          <Switch
            id="watermark-preview"
            checked={watermarkPreviewEnabled}
            onChange={(e) => {
              onChange('preview', e.target.checked);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
