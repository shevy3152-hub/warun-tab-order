# 焼酎12商品カタログ確認表

## 判定

- 対象: 12商品
- 仮画像v1採用対象: 12商品（ユーザー提供の実物ボトル元写真を使用）
- A90一覧thumb v2: 12商品（同じ元写真から非生成で再トリミング。detail v1は変更なし）
- 権利確認待ち画像: 12件（恒久公開利用条件。今回のsafe-copy適用はユーザー指示とZIP READMEに基づく仮運用に限定）
- 画像ファイルの取得・加工: 36件（一覧用thumb v1/v2各12件、詳細用detail v1 12件）
- safe-copyへの取り込み: dry-run（warning 0 / error 0）後に適用済み。production DBは対象外
- 売り文句: 公式商品説明または現行メニュー原稿を根拠に短文化
- 区分・税込価格・stable_id・serving_options: 現行定義を維持

### 添付ZIP候補の確認

- 入力: `C:\Users\user\Pictures\shochu-menu-assets-14-bottles.zip`
- `manifest.json` は14商品のdetail/thumbを列挙し、対象12商品のほか伊佐美・薩摩茶屋の2商品を含む。
- `README.md` とmanifestのprovenanceは、外部商品画像ではなく「ユーザー撮影写真を基にしたAI再構成」としている。READMEはラベル内の細かな文字が実物と完全一致しない場合があると明記している。
- 画像はthumb 560×560 PNG、detail 760×1320 PNG、透過。仕様上のサイズは確認できたが、現行ラベル・容量との一致と権利条件を満たさないため、12対象すべて採用不可、2対象外はマッピングしない。
- 上記理由により、画像対応表へ行を追加せず、画像ファイルをリポジトリ・safe-copyへコピーしていない。外部hotlinkも行っていない。

「公式出典」は商品情報を確認した公式ページ、「画像出典」はページ内の商品画像候補を確認したページを示す。再利用許諾を明示確認できていないため、画像出典URLから画像を直接取り込まず、外部hotlinkもしない。月心は公式メーカーの商品詳細ページを特定できず、現行原稿を根拠にした項目を要確認とする。天誅は公式組合の商品ページで製造者を確認したが、商品詳細の味わい説明は現行原稿以外を追加していない。

| 商品名 | stable_id | 区分 | 税込価格 | 売り文句 | 公式出典 | 画像出典 | 利用条件 | 画像状態 | 要確認事項 |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| 黒霧島 | `shochu-imo-kuro-kirishima` | 芋 | 550円 | 黒麹仕込み。とろりとした甘み、キリッとした後切れ。 | [霧島酒造 商品ページ](https://www.kirishima.co.jp/products/imo/kuro-kirishima/) | ユーザー提供ZIP `originals/shochu-imo-kuro-kirishima.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 明るい農村 | `shochu-imo-akarui-nouson` | 芋 | 660円 | 霧島山系の湧水と甕壺仕込み。芋の甘みを感じる一杯。 | [霧島町蒸留所](https://www.akarui-nouson.com/) | ユーザー提供ZIP `originals/shochu-imo-akarui-nouson.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 赤兎馬 | `shochu-imo-sekitoba` | 芋 | 680円 | 特殊濾過と冠岳の伏流水。淡麗かつ芳醇な芋焼酎。 | [赤兎馬公式](https://www.sekitoba.co.jp/) | ユーザー提供ZIP `originals/shochu-imo-sekitoba.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 熟柿 | `shochu-imo-jukugaki` | 芋 | 720円 | 熟した柿のような甘み。まろやかで円熟した芋焼酎。 | [八千代伝酒造 商品一覧](https://yagishuzou.co.jp/products/) | ユーザー提供ZIP `originals/shochu-imo-jukugaki.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 三岳 | `shochu-imo-mitake` | 芋 | 680円 | 屋久島の清冽な水と芋の旨味。食事に寄り添う味わい。 | [三岳酒造](https://www.mitake-shochu.biz/) | ユーザー提供ZIP `originals/shochu-imo-mitake.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 富乃宝山 | `shochu-imo-tonohozan` | 芋 | 780円 | 黄麹仕込み。華やかな香りと、すっきりしたキレ。 | [西酒造 宝山吟味蔵](https://www.nishi-shuzo.co.jp/%E5%AE%9D%E5%B1%B1%E5%90%9F%E5%91%B3%E8%94%B5/) | ユーザー提供ZIP `originals/shochu-imo-tonohozan.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| いいちこ | `shochu-mugi-iichiko` | 麦・その他 | 550円 | 大麦と大麦麹、清冽な水仕込み。まろやかで飲み飽きない。 | [いいちこ公式 商品ページ](https://www.iichiko.co.jp/products/1.html) | ユーザー提供ZIP `originals/shochu-mugi-iichiko.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 月心 | `shochu-mugi-gesshin` | 麦・その他 | 680円 | 麦の香りを感じる、優しい口当たりとキリッとした辛口。 | [老松酒造公式](https://oimatsu.com/)＋現行原稿 | ユーザー提供ZIP `originals/shochu-mugi-gesshin.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 銀の水 | `shochu-mugi-ginnomizu` | 麦・その他 | 750円 | 国産二条大麦100%。キレのよい口当たり、すっきりした味わい。 | [佐藤焼酎製造場 商品一覧](https://satoshochu.com/products/) | ユーザー提供ZIP `originals/shochu-mugi-ginnomizu.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 朝日 | `shochu-kokuto-asahi` | 麦・その他 | 600円 | 喜界島の自然を映す黒糖焼酎。炭酸割りもおすすめ。 | [朝日酒造公式 商品一覧](https://www.kokuto-asahi.co.jp/collections/kokutoshochu_asahi)＋現行原稿 | ユーザー提供ZIP `originals/shochu-kokuto-asahi.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 残波 白 | `shochu-awamori-zanpa-white` | 麦・その他 | 600円 | フルーティな香りと透明感。軽快で爽やかな泡盛。 | [比嘉酒造 商品ページ](https://www.zanpa.co.jp/%E8%A4%87%E8%A3%BD-zanpa-white-1) | ユーザー提供ZIP `originals/shochu-awamori-zanpa-white.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |
| 天誅 | `shochu-imo-rice-tenchu` | 麦・その他 | 700円 | 芋×米の組み合わせ。すっきり旨口で楽しめます。 | [鹿児島県酒造組合 商品ページ](https://www.honkakushochu.or.jp/product/1876/)＋現行原稿 | ユーザー提供ZIP `originals/shochu-imo-rice-tenchu.jpeg` | ユーザー提供元写真・仮運用 | 仮画像v1・safe-copy適用済み | 恒久公開利用条件の確認 |

## importと管理画面

- 原稿は既存の `server/scripts/import-catalog-markdown.mjs` が受け付ける形式を使用する。safe-copyへの今回の適用対象は、他カテゴリを含まない `docs/shochu-catalog-import.md` とする。
- `description` は客席の短い売り文句、`detail.description` と詳細フィールドは管理画面から個別編集できる値として保持する。
- 画像URIは `docs/shochu-catalog-image-map.md` の既存importer形式へ分離して記録した。safe-copy DBは変更せず、客席一覧だけがv1 URIをv2へ表示時解決する。管理画面またはimport原稿から画像URIだけを差し替えられる。detailはv1のまま維持する。
- 4種類の serving_optionsは既存行を変更しない。Markdown再import時も同じ行を送ることで、未指定による非アクティブ化を防ぐ。

## 仮画像v1の元写真・加工記録

入力ZIP `C:\Users\user\Downloads\shochu-original-photos-12.zip` の `README.md` と `manifest.csv` を確認した。元写真は `originals/` の実物ボトル写真12枚で、manifestの `temporary_source` と商品stable_idの対応を採用した。伊佐美・薩摩茶屋はmanifestに含まれず、商品一覧にもないため対象外とした。

ラベル・ボトルの生成や描き直しは行っていない。加工はEXIF向き補正、手動の軽微な傾き補正、明るさ1.05倍・コントラスト1.04倍、一覧用ラベル中心トリミング、詳細用ボトル全体の縦横比統一、リサイズ、WebP変換のみ。安全な背景除去で商品輪郭を損なう可能性があるため、背景は元写真を保持した。詳細は760×1320、thumbは560×560、WebP quality 88で、画像内に商品名・価格・売り文句は入れていない。

| 商品名 | stable_id | 元写真名 | 元ファイル名 | 元SHA-256 | thumbファイル／SHA-256 | detailファイル／SHA-256 | 利用条件・画像状態 | 要確認事項 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 黒霧島 | `shochu-imo-kuro-kirishima` | `IMG_2755(2).jpeg` | `shochu-imo-kuro-kirishima.jpeg` | `810790d3e4b57d1692ad66f12e39b4c578e726df048411a26927d84da1e049db` | `shochu-imo-kuro-kirishima-thumb-v1.webp` / `d57c539cae11c42ade0613e5f1b6ea7c1d3d7e7bd1d7ee5b6fc9d0febb5f722f` | `shochu-imo-kuro-kirishima-detail-v1.webp` / `8d3ec13b16c230f8022925ccb1604d436f340380f8bbbca3b032f468d64cf90f` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 明るい農村 | `shochu-imo-akarui-nouson` | `IMG_2757(1).jpeg` | `shochu-imo-akarui-nouson.jpeg` | `0222d00bdecfc414ad44fdf33bba62fa4e30f3d461d08fba72720ad958008c11` | `shochu-imo-akarui-nouson-thumb-v1.webp` / `748bffb4c0c627308ecb627b7e40d28d0dc14a11ee95e128f98689a7c892c82c` | `shochu-imo-akarui-nouson-detail-v1.webp` / `8d6414e355765e18d2990fbb0e51a8e2504e39dc2c7bd28730d85c1f07bca1a6` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 赤兎馬 | `shochu-imo-sekitoba` | `IMG_2765.jpeg` | `shochu-imo-sekitoba.jpeg` | `d216d29ff529111b16f5c227f131877208153437d3a66289d2e4f3d4efedf62e` | `shochu-imo-sekitoba-thumb-v1.webp` / `09629cddf72f4f9981bef135f51f7fb6110bb5de1dd756db7b0768aaff8b5a15` | `shochu-imo-sekitoba-detail-v1.webp` / `d7faa5e48358bdc3abb2c852e882db2b32fc3b256640b9ae3633149fbefa416a` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 熟柿 | `shochu-imo-jukugaki` | `IMG_2759.jpeg` | `shochu-imo-jukugaki.jpeg` | `818f24f4406fe5bcab262af81aff469e6fb57139c6a76b3787bcd5e8394b8184` | `shochu-imo-jukugaki-thumb-v1.webp` / `900bb8abd01d90b6b19d212844a85a00c29575ab31537951438a592d8dc9db34` | `shochu-imo-jukugaki-detail-v1.webp` / `fe98fd4d747d6782aa5e54cabe17bd62e115a7d130379ab7870bc7585e0c6891` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 三岳 | `shochu-imo-mitake` | `IMG_2762.jpeg` | `shochu-imo-mitake.jpeg` | `250248984c79df3a19c8de4dc0ca30bf4dd2474e6290c255d5ee457ccff0fa4c` | `shochu-imo-mitake-thumb-v1.webp` / `e16b0b3ee52ca20f4b62e23d505d8d29799455db5e02764847c83d393d8bc0d8` | `shochu-imo-mitake-detail-v1.webp` / `73465f4ad5b8a976f7521e7754943be6709bbf99e92cab4d78c4de247e523b7e` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 富乃宝山 | `shochu-imo-tonohozan` | `IMG_2754.jpeg` | `shochu-imo-tonohozan.jpeg` | `4fe889cf776087644cd364ce89ad9fe747648c2be7e030eb565517f0f78dbee3` | `shochu-imo-tonohozan-thumb-v1.webp` / `ddd4d6c9e73d7ca38dad9d70c9a0367ca0c38d0c95f39888677f704ea3592a17` | `shochu-imo-tonohozan-detail-v1.webp` / `b0376c70fd7c7b6da7cba88acd0106f0305a2e809cadaa8b63e09fb867e10b36` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| いいちこ | `shochu-mugi-iichiko` | `IMG_2756.jpeg` | `shochu-mugi-iichiko.jpeg` | `f0178e8af3f4cc9a60dee5947d742cdc28532e82a788f74359d85687ea8e8a00` | `shochu-mugi-iichiko-thumb-v1.webp` / `91b4b338f2c0da6bc684f5a8f69c7c3be1b8a3e154a0205363545cc1a4b4d3ce` | `shochu-mugi-iichiko-detail-v1.webp` / `82be37a0b570d957ea100f52d1384116749eee32defa23ceb74d27ef7610efa2` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 月心 | `shochu-mugi-gesshin` | `IMG_2763.jpeg` | `shochu-mugi-gesshin.jpeg` | `0dbf838d77e61cfcb610a42446d65310eb1672587fef815c7c2a0c33c41be761` | `shochu-mugi-gesshin-thumb-v1.webp` / `6719084ff07d0268ba783175eb4d7c6e621c8b71fb220c79db55bb5522ac17f0` | `shochu-mugi-gesshin-detail-v1.webp` / `ddacd37b69b7a1610013322627e5c4968ab7eacba30608f8b300cc4835d8729a` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 銀の水 | `shochu-mugi-ginnomizu` | `IMG_2764.jpeg` | `shochu-mugi-ginnomizu.jpeg` | `f75ee25dfb0b55c6e57756b7e7eaa568118a62a298a9dc9c211701d9362188e7` | `shochu-mugi-ginnomizu-thumb-v1.webp` / `9f285df0baab60571b38fd9285ea5f36c767607a38987ac3721dee38ecf1ac9e` | `shochu-mugi-ginnomizu-detail-v1.webp` / `ddf8b05ce89ac1254a40ca08362c6f81b5aee21acdedeb152b209ce5f248a270` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 朝日 | `shochu-kokuto-asahi` | `IMG_2767.jpeg` | `shochu-kokuto-asahi.jpeg` | `0db2ed9ae57209847baf21fa0c9b47616e2e1d36ec043f844fe091301eb08aab` | `shochu-kokuto-asahi-thumb-v1.webp` / `dbe695789654d869898fbe1ceab6f7310f0d259ed1bc63b8b7fc4aeb6a42a73a` | `shochu-kokuto-asahi-detail-v1.webp` / `9dacf306d077400ef06c1832998b689a2aa537ee6f3bd0b514decb43ed434101` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 残波 白 | `shochu-awamori-zanpa-white` | `IMG_2768.jpeg` | `shochu-awamori-zanpa-white.jpeg` | `9cd1d8f9b83c8aedb84ad7a9746dcdf7986568f84a59d607cd1b71d69386a860` | `shochu-awamori-zanpa-white-thumb-v1.webp` / `f578aa8b6425f878f3b57202934ce12999db5933191e48d0fed3c4bf620061ca` | `shochu-awamori-zanpa-white-detail-v1.webp` / `8f88e162f03f3cb328fe1f51085f6098e143177dd5757dd70564cef421db0b80` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |
| 天誅 | `shochu-imo-rice-tenchu` | `IMG_2766.jpeg` | `shochu-imo-rice-tenchu.jpeg` | `d4cf15b356b89b99d16a3240b1bd253728c270ebff7cea32e267bccd1d721c51` | `shochu-imo-rice-tenchu-thumb-v1.webp` / `ce0f5f00000449cba5613167790f07588e8eb8a4b300c3bed14b9acb6326c269` | `shochu-imo-rice-tenchu-detail-v1.webp` / `34f9ab42d5dfa973318d24708f027f92d92feccf35c7822bfc16ff6f906fa05c` | ユーザー提供元写真。仮画像v1としてsafe-copy適用対象 | 恒久公開利用条件の確認 |

加工画像のURIは `docs/shochu-catalog-image-map.md` に既存importer形式で記録し、商品名・価格・売り文句・serving_optionsとは別に更新できる構造とした。版更新時はstable_idとURIの役割を維持し、`-v2`等へ差し替える。

## A90一覧thumb v2の加工記録

v2はdetail v1や元写真を変更せず、元写真12枚へ既存v1と同じEXIF向き補正・軽微な傾き補正・明るさ／コントラスト補正を適用した後、商品ラベルを中央に置く620×760の縦長範囲へ再トリミングし、560×700 WebPへ縮小した。ラベル・ボトルの生成、描き直し、文字の焼き込みはない。客席CSSの88×108表示枠と同じ縦長比率に寄せ、上下白帯を発生させない。主ラベルの主要文字が欠けないことを12枚で目視確認し、上部の小さな補助ラベルが元写真の画角外になる商品は主ラベルを優先した。

| 商品名 | stable_id | thumb v2ファイル／SHA-256 |
| --- | --- | --- |
| 黒霧島 | `shochu-imo-kuro-kirishima` | `shochu-imo-kuro-kirishima-thumb-v2.webp` / `0abc6c9fce2df54a106b6e0571450f24b17c47d0d34a3c2649c7ecb77656eeb3` |
| 明るい農村 | `shochu-imo-akarui-nouson` | `shochu-imo-akarui-nouson-thumb-v2.webp` / `d8d0613a01a4ebf2a00f9eafc5b65c802cab51cb00f390155eeeb3a38a5e47e0` |
| 赤兎馬 | `shochu-imo-sekitoba` | `shochu-imo-sekitoba-thumb-v2.webp` / `78d1cea88ea9c10e8a776a58ac5b400392fdb76e3f1f90dc33867c68b7793671` |
| 熟柿 | `shochu-imo-jukugaki` | `shochu-imo-jukugaki-thumb-v2.webp` / `f0761d5b0ff70ecfc61ffc79b4388db0a3de02b019a2231b47f4ef9217199783` |
| 三岳 | `shochu-imo-mitake` | `shochu-imo-mitake-thumb-v2.webp` / `76a76895f66c9bc4c65cc7af2063648776d839ccdcc37d447b3e7e606a3c1dea` |
| 富乃宝山 | `shochu-imo-tonohozan` | `shochu-imo-tonohozan-thumb-v2.webp` / `e1d683828b99a3fa2d11aec29beb5ac180e436f2fafc2dd42f10f2ec52285e89` |
| いいちこ | `shochu-mugi-iichiko` | `shochu-mugi-iichiko-thumb-v2.webp` / `a4ac1d5dff9fc6b7424d23d073287e9622f70463a87f3df60b6fd7ed5b5f166c` |
| 月心 | `shochu-mugi-gesshin` | `shochu-mugi-gesshin-thumb-v2.webp` / `d7d666cd46ddb3daa7b26a76de592803febb12734b5ab6658ab483d78b0bb926` |
| 銀の水 | `shochu-mugi-ginnomizu` | `shochu-mugi-ginnomizu-thumb-v2.webp` / `a7339c52edd9417614232065fbb90c92db5198a4abbb95109fc335f8c1553cb7` |
| 朝日 | `shochu-kokuto-asahi` | `shochu-kokuto-asahi-thumb-v2.webp` / `b69982a5394d1c9a79116173e32e2ce080ee6c42ec8464eeeb0d190354ca4d2f` |
| 残波 白 | `shochu-awamori-zanpa-white` | `shochu-awamori-zanpa-white-thumb-v2.webp` / `ffb91b6dc4a3fa95ac5d9b30b5f3ed5194a5756388f0405164427c5bcb30f88e` |
| 天誅 | `shochu-imo-rice-tenchu` | `shochu-imo-rice-tenchu-thumb-v2.webp` / `e93c74fba339a63a0cd6043068e373797408fd2afb13247fc2e231248fc984f6` |
