using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace KenMonitorControl {
    // Hidden integration check of the real first-party GET route and projection.
    // No window is displayed and all non-GET requests are blocked by this test.
    sealed class BackgroundCheck : ApplicationContext {
        readonly string report;
        readonly Form owner=new Form {ShowInTaskbar=false,Opacity=0,FormBorderStyle=FormBorderStyle.None,Size=new Size(1,1)};
        readonly WebView2 web=new WebView2();
        readonly System.Windows.Forms.Timer kick=new System.Windows.Forms.Timer {Interval=50};
        readonly System.Windows.Forms.Timer timeout=new System.Windows.Forms.Timer {Interval=15000};
        bool finished;
        public BackgroundCheck(string output) {
            report=output;owner.Controls.Add(web);var handle=owner.Handle;var child=web.Handle;
            kick.Tick+=async(s,e)=>{kick.Stop();await Check();};
            timeout.Tick+=(s,e)=>Finish(new {ok=false,error="背景載入檢查逾時"});
            kick.Start();timeout.Start();
        }
        async Task Check() {
            try {
                string folder=Path.Combine(Path.GetDirectoryName(report),"runtime-check-profile");
                var env=await CoreWebView2Environment.CreateAsync(null,folder);
                await web.EnsureCoreWebView2Async(env);
                string script;
                using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("KenMonitorControl.DesktopOrders"))
                using(var reader=new StreamReader(stream))script=reader.ReadToEnd();
                await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
                using(var icon=Assembly.GetExecutingAssembly().GetManifestResourceStream("KenMonitorControl.AppIcon"))
                    if(icon==null)throw new Exception("缺少圖示資源");
                int blockedWrites=0;
                web.CoreWebView2.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
                web.CoreWebView2.WebResourceRequested+=(s,e)=>{
                    if(e.Request.Method!="GET"){blockedWrites++;e.Response=env.CreateWebResourceResponse(null,403,"Read-only background check","");}
                };
                var navigation=new TaskCompletionSource<CoreWebView2NavigationCompletedEventArgs>();
                web.CoreWebView2.NavigationCompleted+=(s,e)=>navigation.TrySetResult(e);
                web.CoreWebView2.Navigate(OrdersView.DashboardUrl);
                var result=await navigation.Task;
                string projected=await web.CoreWebView2.ExecuteScriptAsync("document.querySelectorAll('#ken-desktop-orders [data-desktop-platform]').length");
                if(!result.IsSuccess||result.HttpStatusCode!=200||projected!="3")throw new Exception("實際桌面載入失敗：HTTP "+result.HttpStatusCode+"，平台數 "+projected);
                Finish(new {ok=true,webViewRuntime=env.BrowserVersionString,desktopScript=script.Contains("ken-desktop-orders"),navigationPerformed=true,httpStatus=result.HttpStatusCode,platforms=projected,blockedWrites,windowShown=false});
            }catch(Exception ex){Finish(new {ok=false,error=ex.GetType().Name+": "+ex.Message});}
        }
        void Finish(object result) {
            if(finished)return;finished=true;kick.Stop();timeout.Stop();
            File.WriteAllText(report,new JavaScriptSerializer().Serialize(result));
            web.Dispose();owner.Dispose();kick.Dispose();timeout.Dispose();ExitThread();
        }
    }
}
