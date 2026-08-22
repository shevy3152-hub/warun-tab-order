# Non-production catalog fixture

## category: fixture-drinks
- name: Fixture Drinks
- sort_order: 1
- is_visible: true

## item: fixture-shochu
- category_id: fixture-drinks
- formal_name: Fixture Shochu
- kitchen_alias: F-Shochu
- description: Fixture-only shochu record; not a real menu item.
- price_yen: 700
- is_sold_out: false
- is_active: true
- sort_order: 1
- section_key: 芋

### detail
- enabled: true
- reading: ふぃくすちゃー
- itemType: 焼酎
- origin: Fixture Origin
- producer: Fixture Producer
- taste: Fixture Taste
- aroma: Fixture Aroma
- sweetness: Fixture Sweetness
- finish: Fixture Finish
- recommendation: Fixture Recommendation
- description: Fixture detail only.

### serving_options
| id | name | sort_order | is_active |
| --- | --- | --- | --- |
| fixture-shochu-rock | Rock | 1 | true |
| fixture-shochu-water | Water | 2 | true |
| fixture-shochu-soda | Soda | 3 | true |
| fixture-shochu-hot | Hot water | 4 | true |

## item: fixture-sake
- category_id: fixture-drinks
- formal_name: Fixture Sake
- kitchen_alias: F-Sake
- description: Fixture-only sake record; not a real menu item.
- price_yen: 900
- is_sold_out: false
- is_active: true
- sort_order: 2
- section_key: null

### detail
- enabled: true
- itemType: 日本酒
- taste: Fixture Taste

### variants
| id | name | volume_label | price_yen | sort_order | is_active | temperature_options |
| --- | --- | --- | --- | --- | --- | --- |
| fixture-sake-glass | Glass | 90ml | 450 | 1 | true | 冷酒 |
| fixture-sake-tokuri | Tokuri | 180ml | 850 | 2 | true | 冷酒,燗酒 |
