# hostfs.sys について

`hostfs.sys` はこのリポジトリの自作物です。同じディレクトリの `許諾条件.txt`
(Sharpのシステムディスク`human302.xdf`等に付く許諾条件の文書)とは無関係です。

- ソース: `tools/x68/hostfs.s`(WebX68kのHostFS機能用のHuman68kデバイスドライバ)
- ビルド: `tools/x68/build-hostfs.sh`(vasmでアセンブル→`tools/x68/hu_pack.py`でX形式化)
- 検査: `scripts/verify-hostfs-sys.sh` を実行すると、このファイルが
  `tools/x68/hostfs.s` からバイト一致で再現できることを確かめられる
  (公開用のGitHub Pagesビルドではvasmを実行できないため、ビルド済みの
  バイナリをここに直接同梱している)。
