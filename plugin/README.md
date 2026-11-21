# Google Flow Studio Plugin for Antigravity

Bu eklenti, yerel `gflow` CLI aracını Antigravity ajanlarına entegre eder:

- **Ücretsiz Fotoğraf Üretimi:** Google AI Flow üzerinden 0 kredi ile `nano-banana`, `nano-banana-pro` ve `imagen-4` görselleri üretir.
- **Kredi-Korumalı Video Üretimi:** `veo-3.1-lite`, `veo-3.1-fast`, `veo-3.1-quality`, `omni-flash-1.2` ile video üretmeden önce her zaman `--dry-run` ile kredi maliyetini hesaplar ve kullanıcıdan açık onay ister.
- **ID & Prompt Kataloğu:** Her görsel ve video benzersiz ID (`img_0001`, `vid_0001`) ile SQLite veritabanına kaydedilir; aranabilir, etiketlenebilir, remix edilebilir ve videoya dönüştürülebilir.

## Kurulum & İlk Giriş

```bash
gflow doctor
gflow auth login
```
