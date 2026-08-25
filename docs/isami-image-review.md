# 伊佐美 仮画像 v1 確認記録

- 対象商品: `menu-24eeac7c-2388-4ef5-87b0-21f5013f5673`（伊佐美）
- 重複商品: `menu-9b92c746-d057-47a6-af93-73ce7b71346b`（画像登録なし）
- 元写真: `C:\Users\user\Downloads\isami.jpg`
- 元写真SHA-256: `8257481667228426CA2C764D7EAA4B7B4DD683B34009B7CA7531988066B13214`
- 2026-08-25背景保持版再加工: 元写真のEXIF向き補正、背景を残した回転、明るさ・コントラスト補正、トリミング、リサイズ、PNG化。瓶・ラベル・文字の生成、描き直し、切り抜き、差し替えは行っていない。同じ既存パスのファイルだけを置換し、DB・URI・importは変更していない。
- 編集元写真は元の場所に保持し、リポジトリへ複製していない。

| 用途 | 商品ID | ファイル | 寸法・形式 | SHA-256 | 透過検査 |
| --- | --- | --- | --- | --- | --- |
| detail | `menu-24eeac7c-2388-4ef5-87b0-21f5013f5673` | `prototype/public/menu-images/shochu/menu-24eeac7c-2388-4ef5-87b0-21f5013f5673-detail-v1.png` | 760×1320 RGB PNG | `0f2a68d34ed3867eefac493e9e4f933f15f9ac5061fb6de3f6450cf68fdf1df8` | alphaなし、背景保持 |
| thumbnail | `menu-24eeac7c-2388-4ef5-87b0-21f5013f5673` | `prototype/public/menu-images/shochu/menu-24eeac7c-2388-4ef5-87b0-21f5013f5673-thumb-v1.png` | 560×700 RGB PNG | `cdfd31dcca0ac8fafba3b563aedd0a9ef1de07961fd96b670c04aa68c7374ca2` | alphaなし、主ラベル中心・背景保持 |

機械処理用の対応表は [isami-image-map.md](isami-image-map.md) に既存の `target | image_uri` 形式で記録した。前回の透明切り抜き版は撤回し、現行ファイルは他の焼酎画像と同じく元写真の背景を含むRGB画像とした。safe-copy配信とA90表示はこの背景保持版で再確認する。
