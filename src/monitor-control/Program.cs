using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KenMonitorControl {
    static class Program {
        [STAThread] static void Main(string[] args) {
            string root = FindRoot();
            if (args.Contains("--self-test")) {
                try {SelfTest.Run();if(args.Length>1)File.WriteAllText(args[1],"{\"ok\":true}");Environment.ExitCode=0;}
                catch(Exception ex){if(args.Length>1)File.WriteAllText(args[1],new JavaScriptSerializer().Serialize(new {ok=false,error=ex.Message}));Environment.ExitCode=1;}
                return;
            }
            if(args.Contains("--background-check")&&args.Length>1){
                Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new BackgroundCheck(args[1]));return;
            }
            if(args.Contains("--layout-check")&&args.Length>1){
                Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
                try{LayoutEvidence.Run(root,args[1]);}catch(Exception ex){File.WriteAllText(args[1],new JavaScriptSerializer().Serialize(new {ok=false,error=ex.ToString()}));Environment.ExitCode=1;}return;
            }
            bool created;
            using (var single = new Mutex(true, "Local\\KenBeybladeMonitorWindow", out created)) {
                if (!created) { MessageBox.Show("控制台已經開啟，請從工作列切換。", "Ken 監控控制台"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (root == null) { MessageBox.Show("找不到監控專案。請從專案內的控制台或桌面捷徑開啟，勿單獨搬移 exe。", "找不到程式"); return; }
                Application.Run(new ControlForm(root));
            }
        }
        static string FindRoot() {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            for (int i = 0; dir != null && i < 5; i++, dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName,"scripts","control-monitor.ps1")) && File.Exists(Path.Combine(dir.FullName,"src","index.js"))) return dir.FullName;
            return null;
        }
    }
    static class Data {
        public static object Get(object source, params string[] keys) {
            object value = source;
            foreach (string key in keys) {
                var map = value as IDictionary<string, object>;
                if (map == null || !map.TryGetValue(key, out value)) return null;
            }
            return value;
        }
        public static bool Yes(object source, params string[] keys) { return Object.Equals(Get(source, keys), true); }
        public static object Parse(string text) { return new JavaScriptSerializer { MaxJsonLength = 48 * 1024 * 1024, RecursionLimit = 150 }.DeserializeObject(text); }
        public static bool IsStatus(object source) { return Get(source,"autoPurchase") is IDictionary<string,object> && Get(source,"japanAuctions") is IDictionary<string,object> && Get(source,"systemPause") is IDictionary<string,object>; }
        public static string Mode(object status, params string[] keys) { return Yes(status,"systemPause","active") ? "已暫停" : Yes(status, keys) ? "已啟用" : "未啟用"; }
    }
    sealed class Snapshot {
        public object Status; public bool Disabled; public bool AutoStart; public bool Watchdog; public bool Recovery; public string Integrity; public string Error;
        public bool CanStop {get{return Status!=null||(Watchdog&&!Disabled);}}
        public string ToggleText {get{return CanStop?"關閉":"啟動";}}
        public string Title {
            get {
                if (Status != null) return Data.Yes(Status,"systemPause","active") ? "服務在線 · 功能已暫停" : "監控服務運作中";
                if (Integrity != null) return "啟動異常 · 狀態資料待處理";
                if (Disabled) return "監控已關閉";
                return Watchdog ? "服務未就緒 · 正在嘗試啟動" : "監控服務未啟動";
            }
        }
    }
    sealed class ControlForm : Form {
        readonly string root;
        readonly Color bg=Color.FromArgb(15,23,39), panel=Color.FromArgb(25,37,56), muted=Color.FromArgb(164,182,204), green=Color.FromArgb(75,218,168);
        readonly HttpClient client = new HttpClient(new HttpClientHandler { UseProxy=false, AllowAutoRedirect=false }) { Timeout=TimeSpan.FromSeconds(2) };
        readonly Label title = new Label(), description = new Label(), updated = new Label(), warning = new Label();
        readonly Label[] platformValues = new Label[4];
        readonly CheckBox autoStart = new ToggleCheckBox();
        readonly TextBox activity = new TextBox();
        readonly List<Button> actions = new List<Button>();
        readonly Button toggleButton;
        readonly OrdersView orderView;
        readonly TableLayoutPanel rootLayout;
        readonly RoundedPanel activityPanel;
        readonly Button logToggle;
        readonly bool backgroundTestMode;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval=4000 };
        bool refreshing, acting, applying; Snapshot latest;
        public ControlForm(string projectRoot,bool backgroundTest=false) {
            backgroundTestMode=backgroundTest;
            root=projectRoot; Text="Ken 監控控制台"; ClientSize=new Size(1160,940); MinimumSize=new Size(1036,800);
            StartPosition=FormStartPosition.CenterScreen; BackColor=bg; ForeColor=Color.White; Font=new Font("Microsoft JhengHei UI",10);AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;DoubleBuffered=true;
            using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("KenMonitorControl.AppIcon"))
                if(stream!=null)using(var source=new Icon(stream,32,32))Icon=(Icon)source.Clone();
            var layout = new LayoutGrid {Name="root-layout", Dock=DockStyle.Fill, Padding=new Padding(24,16,24,16), ColumnCount=1, RowCount=10,BackColor=bg };
            rootLayout=layout;
            int[] heights={62,98,84,34,66,42,100,36,0,30};
            for(int i=0;i<heights.Length;i++)layout.RowStyles.Add(new RowStyle(i==6?SizeType.Percent:(i==1||i==2||i==3||i==5)?SizeType.AutoSize:SizeType.Absolute,i==6?100:heights[i]));
            Controls.Add(layout);
            var header=new Panel {Dock=DockStyle.Fill,Margin=new Padding(0)};
            header.Controls.Add(new PictureBox {Image=IconArt.Render(64),SizeMode=PictureBoxSizeMode.Zoom,Size=new Size(48,48),Location=new Point(0,4)});
            header.Controls.Add(new Label {Text="KEN  監控控制台",Font=new Font(Font.FontFamily,16,FontStyle.Bold),AutoSize=true,Location=new Point(62,2)});
            header.Controls.Add(new Label {Text="BEYBLADE WATCHER  /  本機監控",Font=new Font(Font.FontFamily,9),ForeColor=muted,AutoSize=true,Location=new Point(63,34)});
            layout.Controls.Add(header,0,0);
            var statusPanel=new RoundedPanel {Name="status-card", Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,FillColor=panel,Radius=20,Padding=new Padding(22,16,22,16),Margin=new Padding(0,6,0,10) };
            var statusText=new LayoutGrid {Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,ColumnCount=1,RowCount=2,Margin=new Padding(0),BackColor=panel};
            statusText.RowStyles.Add(new RowStyle(SizeType.AutoSize));statusText.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            title.Name="service-title";title.Text="正在核對狀態…";title.AutoSize=true;title.Margin=new Padding(0,0,0,7);title.Font=new Font(Font.FontFamily,17,FontStyle.Bold);title.ForeColor=green;title.BackColor=panel;title.Dock=DockStyle.Fill;
            description.Name="service-description";description.AutoSize=true;description.Margin=new Padding(0);description.Dock=DockStyle.Fill;description.ForeColor=muted;description.BackColor=panel;description.Text="只連接這台電腦的監控，不讀取或顯示帳密。";
            statusText.Controls.Add(title,0,0);statusText.Controls.Add(description,0,1);statusPanel.Controls.Add(statusText);layout.Controls.Add(statusPanel,0,1);
            var platforms=new LayoutGrid { Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,ColumnCount=4,RowCount=1,Margin=new Padding(0,4,0,6),BackColor=bg };
            platforms.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            string[] names={"FUNBOX 監控","誠品／購物網站","日本網站／日亞","自動下單"};
            for(int i=0;i<4;i++){
                platforms.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,25));
                var card=new RoundedPanel {Name="platform-card-"+i,Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,Radius=15,FillColor=panel,Padding=new Padding(10,14,10,14),Margin=new Padding(0,0,i==3?0:10,0)};
                var content=new LayoutGrid {Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,ColumnCount=1,RowCount=2,Margin=new Padding(0),BackColor=panel};
                content.RowStyles.Add(new RowStyle(SizeType.AutoSize));content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                content.Controls.Add(new Label {Text=names[i],AutoSize=true,Dock=DockStyle.Fill,Margin=new Padding(0,0,0,8),TextAlign=ContentAlignment.MiddleCenter,ForeColor=muted,BackColor=panel,Font=new Font(Font.FontFamily,9)},0,0);
                platformValues[i]=new Label {Name="platform-value-"+i,Text="—",AutoSize=true,Dock=DockStyle.Fill,Margin=new Padding(0),TextAlign=ContentAlignment.MiddleCenter,Font=new Font(Font.FontFamily,10,FontStyle.Bold),BackColor=panel};
                content.Controls.Add(platformValues[i],0,1);card.Controls.Add(content);platforms.Controls.Add(card,i,0);
            }layout.Controls.Add(platforms,0,2);
            warning.AutoSize=true;warning.Margin=new Padding(2,7,2,7);warning.Dock=DockStyle.Fill;warning.ForeColor=Color.FromArgb(255,200,105);warning.TextAlign=ContentAlignment.MiddleLeft;layout.Controls.Add(warning,0,3);
            var controls=new LayoutGrid {Dock=DockStyle.Fill,ColumnCount=3,Margin=new Padding(0,9,0,9),BackColor=bg};
            for(int i=0;i<3;i++)controls.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100f/3));
            toggleButton=Button("啟動／關閉",Color.FromArgb(31,135,113));toggleButton.Enabled=false;
            toggleButton.Click+=async(s,e)=>{await RefreshStatus();if(latest!=null)await Act(latest.CanStop?"Stop":"Start");};
            actions.Add(toggleButton);controls.Controls.Add(toggleButton,0,0);
            AddAction(controls,1,"重啟","Restart",Color.FromArgb(52,100,175));
            var web=Button("網頁",Color.FromArgb(47,65,91));web.Click+=(s,e)=>Open("http://127.0.0.1:3210/");controls.Controls.Add(web,2,0);layout.Controls.Add(controls,0,4);
            var options=new FlowLayoutPanel {Name="options",Dock=DockStyle.Fill,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,WrapContents=true,Margin=new Padding(0),BackColor=bg};
            autoStart.Text="開機啟動／異常復原";autoStart.Margin=new Padding(0,2,14,0);autoStart.Width=250;
            autoStart.CheckedChanged+=async(s,e)=>{if(!applying)await Act(autoStart.Checked?"AutoStartOn":"AutoStartOff");};options.Controls.Add(autoStart);
            var refresh=Button("更新狀態",panel);refresh.Dock=DockStyle.None;refresh.Width=104;refresh.Height=36;refresh.Click+=async(s,e)=>await RefreshStatus();options.Controls.Add(refresh);
            var logs=Button("系統日誌",panel);logs.Dock=DockStyle.None;logs.Width=104;logs.Height=36;logs.Click+=(s,e)=>Open(Path.Combine(root,"logs","系統"));options.Controls.Add(logs);layout.Controls.Add(options,0,5);
            var orderPanel=new RoundedPanel {Dock=DockStyle.Fill,FillColor=bg,Radius=17,Padding=new Padding(7),Margin=new Padding(0,8,0,4)};
            orderView=new OrdersView(root){Name="orders-view",Dock=DockStyle.Fill};orderPanel.Controls.Add(orderView);layout.Controls.Add(orderPanel,0,6);
            logToggle=new RoundedButton {Name="log-toggle",Text="操作 LOG  ▸ 展開",Dock=DockStyle.Fill,BackColor=panel,ForeColor=muted,Margin=new Padding(0,3,0,3),TextAlign=ContentAlignment.MiddleLeft};
            activityPanel=new RoundedPanel {Name="activity-card",Dock=DockStyle.Fill,FillColor=panel,Radius=17,Padding=new Padding(14),Margin=new Padding(0,6,0,4),Visible=false};
            logToggle.Click+=(s,e)=>SetLogExpanded(!activityPanel.Visible);
            layout.Controls.Add(logToggle,0,7);
            activity.Dock=DockStyle.Fill;activity.Multiline=true;activity.ReadOnly=true;activity.ScrollBars=ScrollBars.Vertical;activity.BackColor=panel;activity.ForeColor=muted;activity.BorderStyle=BorderStyle.None;activity.Margin=new Padding(0);activity.Font=new Font(Font.FontFamily,9);
            activity.Text="關閉這個視窗不會停止監控。\r\n「關閉監控」會記住停止狀態，重開機不會擅自啟動。\r\n「開啟監控」只恢復原設定，不會把已關閉的自動下單打開。";activityPanel.Controls.Add(activity);layout.Controls.Add(activityPanel,0,8);
            updated.Dock=DockStyle.Fill;updated.ForeColor=muted;updated.Font=new Font(Font.FontFamily,9);updated.Text="每 4 秒核對一次 · 僅本機連線";layout.Controls.Add(updated,0,9);
            if(!backgroundTest){timer.Tick+=async(s,e)=>await RefreshStatus();Shown+=async(s,e)=>{await RefreshStatus();timer.Start();};}
            FormClosing+=(s,e)=>{if(acting){e.Cancel=true;MessageBox.Show(this,"操作尚未完成，請等狀態核對結束再關閉。","請稍候");}};
            FormClosed+=(s,e)=>{timer.Stop();client.Dispose();};
            if(backgroundTest){ShowInTaskbar=false;Opacity=0;StartPosition=FormStartPosition.Manual;Location=new Point(-30000,-30000);}
        }
        protected override bool ShowWithoutActivation {get{return backgroundTestMode||base.ShowWithoutActivation;}}
        protected override CreateParams CreateParams {get{var cp=base.CreateParams;if(backgroundTestMode)cp.ExStyle|=0x08000000|0x00000080;return cp;}}
        internal void SetLogExpanded(bool expanded){activityPanel.Visible=expanded;rootLayout.RowStyles[8].Height=expanded?108:0;logToggle.Text=expanded?"操作 LOG  ▾ 收合":"操作 LOG  ▸ 展開";}
        internal void PrepareLayoutEvidence(){
            title.Text="監控服務運作中";description.Text="本機控制台已回應 · 下方顯示的是平台設定，不代表商品有庫存。";
            string[] values={"已啟用","已啟用","日網 開 / 日亞 開","有啟用任務"};for(int i=0;i<4;i++)platformValues[i].Text=values[i];
            warning.Text="歷史待核對：完成核對前，請勿啟用自動下單。";applying=true;autoStart.Checked=true;applying=false;
            toggleButton.Text="關閉";toggleButton.BackColor=Color.FromArgb(130,60,73);updated.Text="最後核對 10:30:21 · 每 4 秒更新 · 關閉視窗 ≠ 關閉監控";
        }
        protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);NativeTheme.Apply(this);}
        Button Button(string text,Color color) { return new RoundedButton {Text=text,Dock=DockStyle.Fill,BackColor=color,ForeColor=Color.White,Margin=new Padding(0,0,10,0),Cursor=Cursors.Hand}; }
        void AddAction(TableLayoutPanel parent,int column,string text,string action,Color color) {var b=Button(text,color);b.FlatAppearance.BorderSize=0;b.Click+=async(s,e)=>await Act(action);actions.Add(b);parent.Controls.Add(b,column,0);}
        void Open(string target) {try { Process.Start(new ProcessStartInfo(target){UseShellExecute=true}); }catch {MessageBox.Show(this,"無法開啟。請先確認服務已啟動或資料夾存在。","無法開啟");}}
        async Task RefreshStatus() {
            if(refreshing||IsDisposed)return;refreshing=true;
            try {
                var value=await Task.Run(async()=>{
                    var snap=new Snapshot {Disabled=File.Exists(Path.Combine(root,"data","monitor-disabled.flag")),AutoStart=!File.Exists(Path.Combine(root,"data","monitor-autostart-disabled.flag")),Recovery=File.Exists(Path.Combine(root,"data","order-recovery-required.flag"))};
                    try { using(var response=await client.GetAsync("http://127.0.0.1:3210/api/status")) {response.EnsureSuccessStatusCode();var parsed=Data.Parse(await response.Content.ReadAsStringAsync());if(!Data.IsStatus(parsed))throw new InvalidDataException();snap.Status=parsed;} } catch {snap.Error="本機控制台沒有有效回應";}
                    if(snap.Status==null) {
                        string stateFile=Path.Combine(root,"data","state.json");
                        if(File.Exists(stateFile))try {if(!(Data.Parse(File.ReadAllText(stateFile,Encoding.UTF8)) is IDictionary<string,object>))snap.Integrity="狀態資料格式錯誤";}catch{snap.Integrity="state.json 已損壞；沒有自動覆蓋或清空";}
                        try {int pid;if(Int32.TryParse(File.ReadAllText(Path.Combine(root,"data","monitor-watchdog.pid")).Trim(),out pid)){
                            using(var search=new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId="+pid))foreach(ManagementObject p in search.Get())snap.Watchdog=(Convert.ToString(p["CommandLine"])??"").IndexOf(Path.Combine(root,"scripts","monitor-service.ps1"),StringComparison.OrdinalIgnoreCase)>=0;
                        }}catch{}
                    }
                    return snap;
                });
                if(IsDisposed)return;latest=value;title.Text=value.Title;title.ForeColor=value.Status!=null?green:value.Integrity!=null?Color.FromArgb(255,150,130):Color.FromArgb(255,200,105);
                toggleButton.Text=value.ToggleText;toggleButton.BackColor=value.CanStop?Color.FromArgb(130,60,73):Color.FromArgb(31,135,113);toggleButton.Enabled=!acting;
                description.Text=value.Status!=null?"本機控制台已回應 · 下方顯示的是平台設定，不代表商品有庫存。":value.Integrity??(value.Disabled?"手動停止狀態已保存；按「開啟監控」才會解除。":value.Error);
                platformValues[0].Text=value.Status==null?"—":Data.Mode(value.Status,"funbox","enabled");
                platformValues[1].Text=value.Status==null?"—":Data.Mode(value.Status,"shoppingSites","enabled");
                platformValues[2].Text=value.Status==null?"—":Data.Yes(value.Status,"systemPause","active")?"已暫停": "日網 "+(Data.Yes(value.Status,"japanAuctions","enabled")?"開":"關")+" / 日亞 "+(Data.Yes(value.Status,"japanAuctions","amazonJp","enabled")?"開":"關");
                bool auto=Data.Yes(value.Status,"autoPurchase","enabled");
                var orders=Data.Get(value.Status,"japanAuctions","amazonJpProductOrders") as IEnumerable;
                if(orders!=null)foreach(var line in orders)if(Data.Yes(line,"enabled"))auto=true;
                platformValues[3].Text=value.Status==null?"—":Data.Yes(value.Status,"systemPause","active")?"已暫停":auto?"有啟用任務":"全部停用";
                warning.Text=value.Recovery?"歷史待核對：完成核對前，請勿啟用自動下單。":value.Disabled?"目前已記住關閉；即使勾選開機啟動，也不會自行復活。":"開啟服務不等於所有平台已啟用；詳細任務請看儀表板。";
                applying=true;autoStart.Checked=value.AutoStart;applying=false;
                updated.Text="最後核對 "+DateTime.Now.ToString("HH:mm:ss")+" · 每 4 秒更新 · 關閉視窗 ≠ 關閉監控";
                orderView.SetOnline(value.Status!=null);
            }finally{refreshing=false;}
        }
        async Task Act(string action) {
            if(acting)return;
            if((action=="Stop"||action=="Restart")&&MessageBox.Show(this,action=="Stop"?"要關閉整套監控服務嗎？\n停止狀態會被保留，重開機也不會自行啟動。":"要重新啟動整套監控嗎？\n若有交易或帳號操作正在進行，將拒絕中斷。","確認操作",MessageBoxButtons.OKCancel,MessageBoxIcon.Question)!=DialogResult.OK)return;
            acting=true;foreach(var b in actions)b.Enabled=false;autoStart.Enabled=false;
            string label=action=="Start"?"開啟監控":action=="Stop"?"關閉監控":action=="Restart"?"重啟監控":"更新開機設定";
            activity.AppendText("\r\n"+DateTime.Now.ToString("HH:mm:ss")+"｜"+label+"｜執行中…");
            try {
                var result=await Task.Run(()=>{
                    var info=new ProcessStartInfo {FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),Arguments="-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+Path.Combine(root,"scripts","control-monitor.ps1")+"\" -Action "+action,WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
                    using(var p=new Process {StartInfo=info}) {p.Start();var stdout=p.StandardOutput.ReadToEndAsync();var stderr=p.StandardError.ReadToEndAsync();if(!p.WaitForExit(90000))throw new TimeoutException("操作尚未結束，先查看實際狀態，不要重複送出。");return Data.Parse(stdout.Result.Trim());}
                });
                activity.AppendText("\r\n"+DateTime.Now.ToString("HH:mm:ss")+"｜"+Convert.ToString(Data.Get(result,"message")));
            }catch(Exception ex){activity.AppendText("\r\n"+DateTime.Now.ToString("HH:mm:ss")+"｜操作未確認完成："+(ex is TimeoutException?ex.Message:"請查看目前狀態及系統日誌。"));}
            finally{acting=false;foreach(var b in actions)b.Enabled=true;autoStart.Enabled=true;}
            await RefreshStatus();
        }
    }
    static class SelfTest {
        public static void Run() {
            if(Data.IsStatus(Data.Parse("{}")))throw new Exception("Foreign service accepted");
            var healthy=Data.Parse("{\"autoPurchase\":{},\"japanAuctions\":{},\"systemPause\":{\"active\":false},\"funbox\":{\"enabled\":true}}");
            if(!Data.IsStatus(healthy)||Data.Mode(healthy,"funbox","enabled")!="已啟用")throw new Exception("Healthy status mapping");
            var paused=Data.Parse("{\"autoPurchase\":{},\"japanAuctions\":{},\"systemPause\":{\"active\":true}}");
            if(new Snapshot{Status=paused}.Title!="服務在線 · 功能已暫停")throw new Exception("Paused mapping");
            if(new Snapshot{Disabled=true}.Title!="監控已關閉")throw new Exception("Stop mapping");
            if(new Snapshot{Disabled=true,Integrity="invalid"}.Title!="啟動異常 · 狀態資料待處理")throw new Exception("Corruption hidden");
            if(new Snapshot{Watchdog=true}.Title.IndexOf("未就緒")<0)throw new Exception("Watchdog incorrectly healthy");
            if(new Snapshot{Status=healthy}.ToggleText!="關閉"||new Snapshot{Status=paused}.ToggleText!="關閉")throw new Exception("Online toggle action");
            if(new Snapshot{Disabled=true}.ToggleText!="啟動"||new Snapshot{Watchdog=true,Disabled=true}.CanStop)throw new Exception("Stopped toggle action");
            if(new Snapshot{Watchdog=true}.ToggleText!="關閉")throw new Exception("Starting watchdog must be stoppable");
            using(var icon=IconArt.Render(32))if(icon.GetPixel(16,16).A==0||icon.GetPixel(0,0).A!=0)throw new Exception("Icon alpha");
            using(var button=new RoundedButton{Size=new Size(180,44),Text="啟動",BackColor=Color.DarkCyan})
            using(var image=new Bitmap(180,44)){button.DrawToBitmap(image,new Rectangle(0,0,180,44));}
        }
    }
}
