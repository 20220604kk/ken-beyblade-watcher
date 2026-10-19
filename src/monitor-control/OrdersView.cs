using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KenMonitorControl {
    sealed class OrdersView : UserControl {
        public const string DashboardUrl="http://127.0.0.1:3210/";
        readonly WebView2 web=new WebView2();
        readonly Label message=new Label();
        readonly string root;
        bool initializing,loaded,loading,serviceOnline,configured;
        DateTime retryAfter=DateTime.MinValue;
        public OrdersView(string projectRoot) {
            root=projectRoot;BackColor=Color.FromArgb(15,23,39);
            message.Text="監控未啟動；開啟後會顯示原控制台的自動下單表格。";message.ForeColor=Color.FromArgb(164,182,204);message.Dock=DockStyle.Fill;message.TextAlign=ContentAlignment.MiddleCenter;
            web.Dock=DockStyle.Fill;web.Visible=false;web.DefaultBackgroundColor=BackColor;
            Controls.Add(web);Controls.Add(message);
        }
        public async void SetOnline(bool online) {
            if(IsDisposed)return;
            serviceOnline=online;
            if(!online){ShowMessage("監控服務目前未連線；開啟服務後自動重新連線。");return;}
            if(loaded){message.Visible=false;web.Visible=true;web.BringToFront();return;}
            if(initializing||loading||DateTime.UtcNow<retryAfter)return;initializing=true;ShowMessage("正在載入自動下單集合表…");
            try {
                if(configured&&web.CoreWebView2!=null){loading=true;web.CoreWebView2.Navigate(DashboardUrl);return;}
                var env=await CoreWebView2Environment.CreateAsync(null,Path.Combine(root,"data","desktop-control-browser"));
                await web.EnsureCoreWebView2Async(env);
                web.CoreWebView2.Settings.AreDevToolsEnabled=false;
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
                web.CoreWebView2.Settings.IsStatusBarEnabled=false;
                web.CoreWebView2.NavigationStarting+=(s,e)=>{
                    Uri uri;
                    if(e.Uri=="about:blank"||e.Uri.StartsWith("blob:http://127.0.0.1:3210/",StringComparison.Ordinal))return;
                    if(Uri.TryCreate(e.Uri,UriKind.Absolute,out uri)&&uri.Scheme=="http"&&uri.Host=="127.0.0.1"&&uri.Port==3210)return;
                    e.Cancel=true;if(e.IsUserInitiated)OpenExternal(e.Uri);
                };
                web.CoreWebView2.NewWindowRequested+=(s,e)=>{e.Handled=true;if(e.IsUserInitiated)OpenExternal(e.Uri);};
                web.CoreWebView2.NavigationCompleted+=async(s,e)=>{
                    if(IsDisposed)return;
                    bool projected=false;
                    if(e.IsSuccess&&e.HttpStatusCode>=200&&e.HttpStatusCode<400)try{projected=await web.CoreWebView2.ExecuteScriptAsync("Boolean(document.getElementById('ken-desktop-orders') && document.querySelectorAll('#ken-desktop-orders [data-desktop-platform]').length===3)")=="true";}catch{}
                    if(IsDisposed)return;loading=false;loaded=projected;
                    if(projected&&serviceOnline){message.Visible=false;web.Visible=true;web.BringToFront();}
                    else {retryAfter=DateTime.UtcNow.AddSeconds(15);ShowMessage("下單表格載入失敗"+(e.HttpStatusCode>=400?"（HTTP "+e.HttpStatusCode+"）":"")+"；15 秒後重試，或按「網頁」查看。");}
                };
                string script;
                using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("KenMonitorControl.DesktopOrders"))
                using(var reader=new StreamReader(stream))script=reader.ReadToEnd();
                await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
                configured=true;
                loading=true;web.CoreWebView2.Navigate(DashboardUrl);
            }catch(Exception){loading=false;loaded=false;retryAfter=DateTime.UtcNow.AddSeconds(15);ShowMessage("無法載入下單表格；可先按「網頁」。控制功能仍可使用。");}
            finally{initializing=false;}
        }
        void ShowMessage(string text){message.Text=text;web.Visible=false;message.Visible=true;message.BringToFront();}
        static void OpenExternal(string value) {
            Uri uri;if(!Uri.TryCreate(value,UriKind.Absolute,out uri)||(uri.Scheme!="https"&&uri.Scheme!="http"))return;
            try{Process.Start(new ProcessStartInfo(value){UseShellExecute=true});}catch{}
        }
    }
}
