# 用語集の初期の項目（候補）

（初期項目の候補。内容を確認してから取り込んでください。）

- 方針：AI 安全性の分野で広く使われている用語と、文脈で意味の分かれる一般の語だけを入れる。特定の著作に固有の語は入れない。各項目は単一の正解ではなく、訳の候補と注記の集まりとする（翻訳のプロンプトには「推奨の訳」として渡し、文脈に合わなければ使わない）。
- 確認：日本語と英語の候補を含め、運営環境の参加者が語の選び方と訳語を確認してください。仏語、中国語（簡体字）、中国語（繁体字）の候補は、すべて**要確認**です。
- 取り込み：表 `glossary_entries` は（語、語の言語、訳の先の言語）を単位とするので、各項目から、5言語の間の向きごとの行を作る（例：英語の語 → 日本語の候補、日本語の語 → 英語の候補）。「原語のまま可」は `keep_original` の候補にする。
- 繁体字は台湾の、簡体字は中国大陸の語彙と表記とする。
- 英語を基準にしない：A の用語は、英語の研究の文献に由来するものが多いので、英語の語を見出しにしている。ただし、用語集の仕組みは英語を基準にしない。取り込みでは、5言語のすべての向きの行を作る。日本語、仏語、中国語から始まる語（B のような語）も、同じ重みで足せる。
- 変更の進め方：場の投稿で提案し、訳の先の言語の担当が採否を決める。

## A. AI 安全性の分野の用語

1. **AI alignment**
   - 英：AI alignment
   - 日：AIアライメント、AIアラインメント
   - 仏：alignement de l'IA
   - 簡：AI对齐、人工智能对齐
   - 繁：AI對齊、人工智慧對齊
   - 注記：「整列」「配置」とは訳さない。日本語の表記は「アライメント」と「アラインメント」が併存する。場では「アライメント」を先に挙げる。

2. **AI safety**
   - 英：AI safety
   - 日：AI安全性、AIの安全性
   - 仏：sûreté de l'IA
   - 簡：AI安全、人工智能安全
   - 繁：AI安全、人工智慧安全
   - 注記：safety（事故や意図しない害を防ぐこと）と security（攻撃から守ること）を区別する。仏語は sûreté（safety）と sécurité（security）で分ける。中国語はどちらも「安全」になりやすいので、区別が要る文脈では注記を足す。

3. **AI security**
   - 英：AI security
   - 日：AIセキュリティ
   - 仏：sécurité de l'IA
   - 簡：AI安全防护、人工智能安全防护
   - 繁：AI資安、人工智慧資訊安全
   - 注記：AI safety（事故や意図しない害を防ぐこと）と取り違えない。こちらは、攻撃から守ることを指す。

4. **interpretability**
   - 英：interpretability
   - 日：解釈可能性
   - 仏：interprétabilité
   - 簡：可解释性
   - 繁：可解釋性

5. **mechanistic interpretability**
   - 英：mechanistic interpretability
   - 日：メカニスティック解釈可能性、機械論的解釈可能性
   - 仏：interprétabilité mécaniste
   - 簡：机制可解释性
   - 繁：機制可解釋性

6. **reward hacking**
   - 英：reward hacking
   - 日：報酬ハッキング
   - 仏：piratage de la récompense（英語のまま使われることも多い）
   - 簡：奖励黑客、奖励投机
   - 繁：獎勵駭客、獎勵投機
   - 注記：原語のまま可。

7. **specification gaming**
   - 英：specification gaming
   - 日：仕様ゲーミング
   - 仏：contournement de la spécification（英語のまま使われることも多い）
   - 簡：规范博弈、规格投机
   - 繁：規範博弈、規格投機
   - 注記：原語のまま可。

8. **corrigibility**
   - 英：corrigibility
   - 日：修正可能性、コリジビリティ
   - 仏：corrigibilité
   - 簡：可纠正性、可修正性
   - 繁：可修正性、可矯正性
   - 注記：人による修正や停止を受け入れる性質。「訂正しやすさ」の一般の意味ではない。

9. **deceptive alignment**
   - 英：deceptive alignment
   - 日：欺瞞的アライメント
   - 仏：alignement trompeur
   - 簡：欺骗性对齐
   - 繁：欺騙性對齊

10. **inner alignment**
    - 英：inner alignment
    - 日：内部アライメント
    - 仏：alignement interne
    - 簡：内部对齐
    - 繁：內部對齊

11. **outer alignment**
    - 英：outer alignment
    - 日：外部アライメント
    - 仏：alignement externe
    - 簡：外部对齐
    - 繁：外部對齊

12. **mesa-optimizer**
    - 英：mesa-optimizer
    - 日：メサ最適化器
    - 仏：mesa-optimiseur
    - 簡：内层优化器、mesa 优化器
    - 繁：內層最佳化器、mesa 最佳化器
    - 注記：原語のまま可。

13. **red teaming**
    - 英：red teaming
    - 日：レッドチーミング
    - 仏：red teaming、tests d'équipe rouge
    - 簡：红队测试
    - 繁：紅隊演練、紅隊測試

14. **existential risk (x-risk)**
    - 英：existential risk (x-risk)
    - 日：存亡リスク、実存的リスク
    - 仏：risque existentiel
    - 簡：生存风险、存在性风险
    - 繁：生存風險、存在性風險
    - 注記：人類の存続や将来の可能性を損なう規模のリスク。哲学の「実存」の意味ではない。

15. **catastrophic risk**
    - 英：catastrophic risk
    - 日：破局的リスク、壊滅的リスク
    - 仏：risque catastrophique
    - 簡：灾难性风险
    - 繁：災難性風險

16. **frontier AI**
    - 英：frontier AI
    - 日：フロンティアAI
    - 仏：IA de pointe
    - 簡：前沿人工智能
    - 繁：前沿人工智慧

17. **frontier model**
    - 英：frontier model
    - 日：フロンティアモデル
    - 仏：modèle de pointe、modèle de frontière
    - 簡：前沿模型
    - 繁：前沿模型

18. **AGI (artificial general intelligence)**
    - 英：AGI (artificial general intelligence)
    - 日：汎用人工知能（AGI）
    - 仏：intelligence artificielle générale（IAG、AGI）
    - 簡：通用人工智能（AGI）
    - 繁：通用人工智慧（AGI）

19. **superintelligence**
    - 英：superintelligence
    - 日：超知能
    - 仏：superintelligence
    - 簡：超级智能
    - 繁：超級智慧

20. **scalable oversight**
    - 英：scalable oversight
    - 日：スケーラブルな監督
    - 仏：supervision évolutive
    - 簡：可扩展监督
    - 繁：可擴展監督

21. **evals（dangerous capability evaluations）**
    - 英：evals（dangerous capability evaluations）
    - 日：評価（危険な能力の評価）
    - 仏：évaluations（des capacités dangereuses）
    - 簡：评测（危险能力评测）
    - 繁：評測（危險能力評測）
    - 注記：モデルの能力や危険性を測る試験の意味。一般の「評価」と区別が要る文脈では補う。

22. **jailbreak**
    - 英：jailbreak
    - 日：ジェイルブレイク、脱獄
    - 仏：jailbreak、contournement
    - 簡：越狱
    - 繁：越獄

23. **prompt injection**
    - 英：prompt injection
    - 日：プロンプトインジェクション
    - 仏：injection de prompt、injection d'instructions
    - 簡：提示注入、提示词注入
    - 繁：提示詞注入

24. **model weights**
    - 英：model weights
    - 日：モデルの重み
    - 仏：poids du modèle
    - 簡：模型权重
    - 繁：模型權重

25. **open-weight model**
    - 英：open-weight model
    - 日：オープンウェイトモデル、重み公開モデル
    - 仏：modèle à poids ouverts
    - 簡：开放权重模型
    - 繁：開放權重模型
    - 注記：「オープンソース」とは区別する（重みだけが公開されていることが多い）。

26. **compute（名詞）**
    - 英：compute
    - 日：計算資源
    - 仏：puissance de calcul、ressources de calcul
    - 簡：算力、计算资源
    - 繁：算力、運算資源
    - 注記：動詞の「計算する」ではない。

27. **AI governance**
    - 英：AI governance
    - 日：AIガバナンス
    - 仏：gouvernance de l'IA
    - 簡：人工智能治理
    - 繁：人工智慧治理

## B. 文脈で意味の分かれる一般の語（日本語の語を基準にする）

28. **共生**
    - 英：coexistence、symbiosis
    - 仏：coexistence、symbiose
    - 簡：共生、共存
    - 繁：共生、共存
    - 注記：人と AI の関係を言うときは、多くは「共に存在し、影響し合う」の意味（coexistence）。生物の共生の比喩であることが明らかなときだけ symbiosis にする。

29. **制御**
    - 英：control
    - 仏：contrôle
    - 簡：控制
    - 繁：控制
    - 注記：AI 安全性の文脈では、「AI control」（不整合でありうる AI を安全に使うための研究の分野）を指すことがある。一般の制御と区別が要る文脈では補う。

30. **価値観**
    - 英：values
    - 仏：valeurs
    - 簡：价值观
    - 繁：價值觀
    - 注記：「人間の価値観に沿わせる」のように、人や社会が大切にするものを指す。英語では複数形の values。

31. **価値**
    - 英：value
    - 仏：valeur
    - 簡：价值
    - 繁：價值
    - 注記：文脈で意味が分かれる。大切にするもの（value、values）か、経済的な値打ち（worth、value）かを、文脈で判断する。

32. **安全性**
    - 英：safety
    - 仏：sûreté
    - 簡：安全性
    - 繁：安全性
    - 注記：security（セキュリティ。攻撃から守ること）と区別する。

33. **熟議**
    - 英：deliberation
    - 仏：délibération
    - 簡：审议
    - 繁：審議
    - 注記：「議論」（discussion、debate）と区別する。台湾では deliberative democracy を「審議民主」と訳すのが通例。中国大陸の「协商」は「协商民主」として政治の制度の含意を持つので、候補にしない（参加者に確かめる）。
