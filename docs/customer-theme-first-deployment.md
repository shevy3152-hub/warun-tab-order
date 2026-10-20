# 初回反映: 客席レール画像管理

今回の機能を初めてsafe-copyへ反映するときは、Web UIのbuild、スキーマ24への移行、永続画像保存先の設定が必要です。通常のテーマ追加・画像差替えは、反映後に管理画面から行えます。

## 初回反映手順

1. 反映前にsafe-copyを停止し、現在のDBと既存の画像保存先を同じ日時のバックアップセットへ保全します。稼働中のsafe-copyやDBは、この手順書作成時には変更していません。
2. 管理対象ソースからWeb UIを一度buildし、成果物をsafe-copyが使うWebRootへ配置します。
3. `server/start-safe-copy.ps1` はschema24を要求し、`WARUN_CUSTOMER_THEME_IMAGE_STORAGE_PATH` が未設定なら `%LOCALAPPDATA%\WarunTabOrder\customer-theme-images` を使います。この場所はWebRootの外にあり、Web成果物の差替えで消えません。別の場所を使う場合も、WebRoot外の永続パスを指定してください。
4. 管理対象ソースの起動経路からsafe-copyを起動します。schema23のDBは初回起動時にschema24へ移行されます。healthがready、DBがready、schemaVersionが24であることを確認します。
5. 管理画面から新しいテーマ画像を追加し、差替え、プレビュー、倍率/X/Y調整、選択保存、客席表示を確認します。

## DBと画像のバックアップ・復旧

- safe-copyを正常停止してSQLiteのWALを閉じた後、safe-copy DBと `customer-theme-images` ディレクトリを同一バックアップセットへ保存します。DBには選択中テーマと画像ファイル名が記録され、画像本体は別ディレクトリにあります。
- 復旧するときはsafe-copyを停止した状態で、同じバックアップセットのDBと画像ディレクトリを一緒に戻してから起動します。異なる時点のDBと画像フォルダを組み合わせないでください。
- WebRootを更新するときはWeb成果物だけを差し替え、`customer-theme-images` は保持します。画像の追加・差替えはAPI経由でこの保存先へ書き込まれ、buildやプロセス再起動を要しません。

## 今回の準備範囲

schema24対応、外部永続画像パスの環境変数転送、起動時health目標をworktree内の管理対象ソースで準備しました。safe-copy、稼働DB、外部に配置済みの `open-admin.ps1`、WebRoot、稼働プロセスには反映していません。
