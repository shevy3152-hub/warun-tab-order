# 非本番カタログMarkdown importer形式

正式メニューを推測して補完しないため、importerは明示されたstable IDと必須項目だけを受け付ける。現時点では正式Markdownと正式画像対応表は未提供なので、`server/test/fixtures/`の架空fixtureだけを検証に使う。

## 実行

まずdry-runを実行する。

```text
node server/scripts/import-catalog-markdown.mjs \
  --target-kind fixture \
  --database PATH_TO_NON_PRODUCTION_DB \
  --markdown PATH_TO_MENU.md \
  --image-map PATH_TO_IMAGE_MAP.md
```

適用する場合だけ`--apply`を付ける。`--target-kind production`は拒否され、適用前にSQLiteのserialize backupを作成する。backupの保存先は`--backup PATH`で明示できる。

## Markdown

カテゴリと商品はstable IDを見出しに明示する。

```markdown
## category: fixture-drinks
- name: Fixture Drinks
- sort_order: 1
- is_visible: true

## item: fixture-sake
- category_id: fixture-drinks
- formal_name: Fixture Sake
- kitchen_alias: F-Sake
- description: Fixture-only record.
- price_yen: 900
- is_sold_out: false
- is_active: true
- sort_order: 1
- section_key: null

### detail
- enabled: true
- itemType: 日本酒
- taste: Fixture Taste

### variants
| id | name | volume_label | price_yen | sort_order | is_active | temperature_options |
| --- | --- | --- | --- | --- | --- | --- |
| fixture-sake-glass | Glass | 90ml | 450 | 1 | true | 冷酒 |
```

`variants`は日本酒のグラス／徳利などの価格選択、`temperature_options`は提供可能な温度（`冷酒` または `燗酒`）をカンマ区切りで指定する。省略時はグラスを冷酒のみ、それ以外を冷酒・燗酒として扱う。`serving_options`は焼酎の飲み方を表す。`section_key`は焼酎内区分を表す。価格は既存仕様どおり税込マスター価格の整数円で、税抜価格は保存しない。

## 画像対応表

画像はMarkdown本文から推測せず、別表でstable IDへ対応付ける。

```markdown
| target | image_uri |
| --- | --- |
| fixture-sake | /fixture/menu/fixture-sake.webp |
| fixture-sake.detail | /fixture/menu/fixture-sake-detail.webp |
```

対応がない商品はwarningになり、既存画像を消さず、新規商品では画像なしで適用する。不明なstable ID、重複対応、空URIはerrorとして適用前に停止する。

## 安全性

importerは入力を全件検証してから差分計画を作る。同じ計画をdry-runと適用で使い、適用は単一SQLiteトランザクションで行う。失敗時は全変更をrollbackし、既存の`orders`、`order_items`、注文時点スナップショット、既存`event_log`を削除しない。既存商品はstable IDで更新し、同じ内容は`unchanged`としてイベントも追加しない。
