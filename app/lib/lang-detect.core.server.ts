import { isLang, type Lang, type SourceLang } from "~/lib/languages";
import { proseOf } from "~/lib/llm/structure.core.server";
import { mentionCandidates, withoutResolvedMentions } from "~/lib/mention-syntax";

// Common simplified/traditional pairs. Shared characters carry no evidence about the script.
const pairs = "们們 这這 个個 说說 为為 发發 对對 开開 时時 会會 来來 过過 还還 点點 动動 学學 现現 关關 种種 经經 进進 实實 应應 问問 与與 无無 将將 并並 户戶 请請 设設 载載 删刪 档檔 邮郵 码碼 链鏈 显顯 该該 选選 择擇 输輸 确確 认認 账賬 号號 隐隱 复復 统統 计計 国國 语語 汉漢 书書 车車 马馬 门門 风風 云雲 电電 东東 乐樂 长長 万萬 专專 业業 严嚴 两兩 丽麗 举舉 义義 乌烏 乔喬 习習 乡鄉 买買 乱亂 争爭 于於 亚亞 产產 亲親 亿億 仅僅 从從 仓倉 仪儀 价價 众眾 优優 传傳 伤傷 伦倫 伪偽 体體 余餘 佣傭 侠俠 侣侶 侥僥 侦偵 侧側 侨僑 俭儉 债債 倾傾 偿償 儿兒 兑兌 党黨 兰蘭 关關 兴興 养養 兽獸 内內 冈岡 册冊 写寫 军軍 农農 冯馮 冲沖 决決 况況 冻凍 净淨 凉涼 减減 凑湊 凤鳳 凭憑 凯凱 击擊 划劃 刘劉 则則 刚剛 创創 删刪 别別 制製 剂劑 剑劍 剧劇 劝勸 办辦 务務 势勢 勋勳 匀勻 区區 医醫 华華 协協 单單 卖賣 卢盧 卫衛 厅廳 历歷 压壓 厌厭 县縣 参參 双雙 变變 叠疊 叶葉 吓嚇 吕呂 吗嗎 听聽 启啟 吴吳 员員 呕嘔 咏詠 响響 哑啞 哗嘩 唤喚 啧嘖 喷噴 团團 园園 围圍 图圖 圆圓 圣聖 场場 坏壞 块塊 坚堅 坛壇 坝壩 坞塢 垄壟 垒壘 垦墾 执執 墙牆 壮壯 声聲 壳殼 壶壺 处處 备備 够夠 头頭 夹夾 夺奪 奋奮 奖獎 妇婦 妈媽 娴嫻 婴嬰 孙孫 宁寧 宝寶 审審 宪憲 宫宮 宽寬 宾賓 寝寢 导導 寿壽 尝嘗 尧堯 尽盡 层層 属屬 岁歲 岂豈 岗崗 岛島 岭嶺 岳嶽 峡峽 峦巒 巩鞏 帅帥 师師 帐帳 帘簾 帜幟 带帶 帮幫 庄莊 庆慶 庐廬 库庫 庞龐 废廢 广廣 异異 弃棄 张張 弥彌 弯彎 弹彈 强強 归歸 当當 录錄 径徑 忆憶 忧憂 怀懷 态態 怂慫 怜憐 总總 恋戀 恳懇 恶惡 恼惱 悦悅 悬懸 惊驚 惧懼 惨慘 惩懲 惫憊 惭慚 惯慣 愤憤 愿願 戏戲 战戰 扑撲 扩擴 扫掃 扬揚 扰擾 抚撫 抛拋 抢搶 护護 报報 担擔 拟擬 拢攏 拣揀 拥擁 拦攔 拧擰 拨撥 挂掛 挚摯 挤擠 挥揮 捞撈 损損 捡撿 换換 据據 掳擄 掷擲 掸撣 掺摻 摄攝 摆擺 摇搖 摊攤 撑撐 撵攆 敌敵 敛斂 数數 斋齋 斩斬 断斷 昼晝 晋晉 晓曉 暂暫 术術 机機 杀殺 杂雜 权權 条條 杨楊 极極 构構 枢樞 枣棗 枪槍 柜櫃 树樹 样樣 桥橋 梦夢 检檢 楼樓 标標 欢歡 欧歐 歼殲 毁毀 毕畢 气氣 汇匯 汤湯 沟溝 没沒 泽澤 洁潔 浅淺 测測 浓濃 涛濤 润潤 涨漲 涡渦 满滿 滤濾 滥濫 滨濱 潜潛 灭滅 灯燈 灵靈 灾災 炉爐 炼煉 烟煙 烧燒 热熱 焕煥 爱愛 爷爺 牍牘 牵牽 犹猶 独獨 狭狹 狮獅 狱獄 猎獵 猪豬 献獻 环環 玺璽 琼瓊 瑶瑤 瓮甕 畅暢 疗療 疯瘋 痴癡 瘫癱 皱皺 盘盤 睁睜 矿礦 砚硯 硕碩 礼禮 祷禱 祸禍 禅禪 离離 积積 称稱 稳穩 穷窮 窍竅 窝窩 窥窺 窜竄 竞競 笔筆 笼籠 筑築 筛篩 筹籌 签簽 简簡 篮籃 类類 粮糧 纤纖 红紅 约約 级級 纪紀 纯純 纲綱 纳納 纵縱 纷紛 纸紙 纹紋 纺紡 纽紐 线線 练練 组組 细細 织織 终終 绊絆 绍紹 绎繹 络絡 绝絕 绞絞 绣繡 继繼 绩績 绪緒 续續 绳繩 维維 绵綿 综綜 绿綠 缓緩 缘緣 缝縫 缩縮 缴繳 网網 罗羅 罚罰 罢罷 职職 联聯 聪聰 肃肅 肠腸 胜勝 胶膠 脏髒 脑腦 脚腳 脱脫 脸臉 艰艱 艺藝 节節 范範 荐薦 药藥 莲蓮 获獲 营營 萧蕭 萨薩 蓝藍 虚虛 虫蟲 虽雖 蚀蝕 蚁蟻 虾蝦 补補 装裝 袜襪 袭襲 见見 观觀 规規 视視 览覽 觉覺 触觸 誉譽 计計 订訂 讣訃 讨討 让讓 训訓 议議 讯訊 记記 讲講 许許 论論 讼訟 访訪 证證 评評 识識 诉訴 词詞 译譯 试試 诗詩 诚誠 话話 询詢 诞誕 诡詭 诫誡 诬誣 误誤 诱誘 诲誨 谅諒 谈談 谊誼 谋謀 谓謂 谢謝 谣謠 谨謹 谱譜 贝貝 贞貞 负負 财財 贡貢 贫貧 货貨 贩販 贪貪 贯貫 贵貴 贷貸 贸貿 费費 贺賀 贼賊 资資 贾賈 赈賑 赊賒 赋賦 赌賭 赎贖 赏賞 赐賜 赔賠 赖賴 赚賺 赛賽 赞贊 趋趨 跃躍 践踐 踪蹤 轨軌 转轉 轮輪 软軟 轰轟 轴軸 轻輕 辅輔 辆輛 辈輩 辉輝 辑輯 辩辯 达達 迁遷 运運 迟遲 适適 递遞 逻邏 遗遺 遥遙 邹鄒 郑鄭 酿釀 释釋 针針 钉釘 钓釣 钟鐘 钢鋼 钱錢 铁鐵 铃鈴 铜銅 铭銘 银銀 铺鋪 锋鋒 锐銳 错錯 锡錫 锦錦 键鍵 镇鎮 镜鏡 闪閃 闭閉 闲閒 间間 闻聞 阅閱 队隊 阳陽 阴陰 阵陣 阶階 际際 陆陸 陈陳 险險 随隨 难難 雾霧 静靜 页頁 顶頂 项項 顺順 须須 顾顧 领領 颇頗 颗顆 题題 颜顏 额額 飞飛 饭飯 饮飲 饱飽 饰飾 饼餅 馆館 驱驅 验驗 骑騎 骗騙 鱼魚 鸟鳥 鸡雞 鸭鴨 鹅鵝 鹰鷹 齐齊 齿齒 龙龍".split(" ");
const simplified = new Set(pairs.map(pair => pair[0]).filter(ch => !pairs.some(pair => pair[1] === ch)));
const traditional = new Set(pairs.map(pair => pair[1]).filter(ch => !pairs.some(pair => pair[0] === ch)));
const otherWords = {
  it: new Set("il lo gli le un una uno di del della delle degli da dal in nel nella con su per tra fra è sono era essere ha hanno che chi non si ma come questo questa questi queste io tu noi voi loro mio mia nostro anche più perché quando dove tutto molto alla alle al ai dei mi ci ed".split(" ")),
  es: new Set("el la los las un una unos unas de del en con por para sin es son era ser ha han que quien no se pero como este esta estos estas yo tú nosotros vosotros ellos ellas mi mis nuestro también más porque cuando donde todo muy al hay está están sus su y".split(" ")),
  pt: new Set("o a os as um uma uns umas de do da dos das em no na nos nas com por para sem é são era ser tem têm que quem não se mas como este esta estes estas eu tu nós vós eles elas meu minha nosso também mais porque quando onde tudo muito ao aos pelo pela e seu sua".split(" ")),
};
const otherScripts: [RegExp, string | null][] = [
  [/\p{Script=Greek}/u, "el"], [/\p{Script=Armenian}/u, "hy"], [/\p{Script=Georgian}/u, "ka"],
  [/\p{Script=Cyrillic}/u, null], [/\p{Script=Arabic}/u, null], [/\p{Script=Hebrew}/u, null],
  [/\p{Script=Devanagari}/u, null], [/\p{Script=Bengali}/u, null], [/\p{Script=Tamil}/u, null],
  [/\p{Script=Telugu}/u, null], [/\p{Script=Kannada}/u, null], [/\p{Script=Malayalam}/u, null],
  [/\p{Script=Gujarati}/u, null], [/\p{Script=Gurmukhi}/u, null], [/\p{Script=Sinhala}/u, null],
  [/\p{Script=Myanmar}/u, null], [/\p{Script=Khmer}/u, null], [/\p{Script=Lao}/u, null], [/\p{Script=Ethiopic}/u, null],
];
const words = {
  en: new Set("the a an of to in on for with from by at is are was were be been being have has had do does did will would can could should may might must this that these those it its we you they he she and or but not as if so our their your".split(" ")),
  fr: new Set("le la les un une des du de au aux à en dans sur pour par avec sans est sont était être été avoir a ont avait ce cette ces il elle ils elles nous vous on et ou mais ne pas que qui se son sa ses leur leurs notre votre comme si quand".split(" ")),
  de: new Set("der die das ein eine einer eines den dem des zu zum zur von mit auf für aus bei nach über unter ist sind war waren sein hat haben hatte wird werden kann können muss nicht und oder aber als wenn dass ich du er sie es wir ihr mein dein sich im am".split(" ")),
};

export type LanguageDecision = { source: "explicit" | "detected" | "default"; detected: SourceLang | null; langCode?: string | null };

// Pure, conservative evidence from prose alone; never guesses from names or identifiers.
function detect(body: string, hint?: string | null, extended = false): string | null {
  const prose = proseOf(body, true);
  const mentions = mentionCandidates(prose).map(c => `@${c.token}`);
  const text = withoutResolvedMentions(prose, mentions).normalize("NFC").toLowerCase().replace(/’/g, "'");
  const letters = [...text].filter(ch => /\p{L}/u.test(ch));
  const count = (pattern: RegExp) => letters.filter(ch => pattern.test(ch)).length;
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/u);
  if (kana >= 2 && kana + count(/\p{Script=Han}/u) > letters.length / 2) return "ja";
  if (count(/\p{Script=Hangul}/u) > letters.length / 2) return "ko";
  if (count(/\p{Script=Thai}/u) > letters.length / 2) return "th";
  const han = count(/\p{Script=Han}/u);
  if (kana === 0 && han > letters.length / 2) {
    const a = letters.filter(ch => simplified.has(ch)).length;
    const b = letters.filter(ch => traditional.has(ch)).length;
    if (hint === "ja" || hint === "zh-Hans" || hint === "zh-Hant") {
      // Japanese shinjitai overlap both scripts. Short text and repeated markers
      // need author context; longer text can override it with varied evidence.
      const markers = a > b ? simplified : traditional;
      const strong = han >= 12 && Math.abs(a - b) >= Math.max(4, Math.ceil(han / 4))
        && new Set(letters.filter(ch => markers.has(ch))).size >= 4;
      if (!strong) return hint;
    }
    return a === b ? null : a > b ? "zh-Hans" : "zh-Hant";
  }
  if (extended && letters.length >= 8) {
    for (const [script, code] of otherScripts) if (count(script) > letters.length / 2) return code ?? "other";
  }
  const latin = count(/\p{Script=Latin}/u);
  if (latin < 25 || latin <= letters.length / 2) return null;
  // Shared acute/grave vowels alone do not distinguish Vietnamese from French.
  if (count(/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/u) >= 2) return "vi";
  const tokens = text.match(/\p{L}+/gu) ?? [];
  const candidates: Record<string, Set<string>> = extended ? { ...words, ...otherWords } : words;
  const scores = Object.keys(candidates).map(lang => {
    const hits = tokens.filter(word => candidates[lang].has(word)).length;
    const bonus = lang === "fr" ? count(extended ? /[œ]/u : /[éèâêôçàùœ]/u) + (text.match(/\b(?:l|d|qu|n)'/g) ?? []).length : lang === "de" ? count(/[äöüß]/u) : 0;
    return { lang, hits, score: hits + bonus };
  }).sort((a, b) => b.score - a.score);
  return scores[0].hits >= 3 && scores[0].score >= 2 * scores[1].score ? scores[0].lang : null;
}

// Other translation surfaces retain their existing language selection rules.
export function detectLang(body: string, hint?: string | null): Lang | null {
  return detect(body, hint) as Lang | null;
}

export function detectSourceLanguage(body: string, hint?: string | null): { lang: SourceLang; langCode: string | null } | null {
  const code = detect(body, hint, true);
  return code ? { lang: isLang(code) ? code : "other", langCode: isLang(code) || code === "other" ? null : code } : null;
}
