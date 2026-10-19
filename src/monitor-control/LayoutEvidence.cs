using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KenMonitorControl {
    static class LayoutEvidence {
        static IEnumerable<Control> All(Control c){yield return c;foreach(Control child in c.Controls)foreach(var item in All(child))yield return item;}
        static void Layout(Control c){c.PerformLayout();foreach(Control child in c.Controls)Layout(child);}
        public static void Run(string root,string report) {
            var cases=new List<object>();string dir=Path.GetDirectoryName(report);Directory.CreateDirectory(dir);
            foreach(var size in new[]{new Size(1000,760),new Size(1160,940),new Size(1400,1000)})foreach(float scale in new[]{1f,1.25f,1.5f})foreach(bool logOpen in new[]{false,true}) {
                using(var form=new ControlForm(root,true)) {
                    form.MinimumSize=Size.Empty;form.ClientSize=size;form.PrepareLayoutEvidence();form.SetLogExpanded(logOpen);
                    var handle=form.Handle;form.Show();form.AutoScaleMode=AutoScaleMode.None;
                    if(scale!=1){
                        var originals=All(form).Select(c=>new {Control=c,Font=c.Font}).ToArray();
                        form.Scale(new SizeF(scale,scale));
                        foreach(var item in originals)item.Control.Font=new Font(item.Font.FontFamily,item.Font.Size*scale,item.Font.Style);
                        form.ClientSize=new Size((int)(size.Width*scale),(int)(size.Height*scale));
                    }
                    for(int i=0;i<4;i++)Layout(form);
                    var violations=new List<string>();var labels=new List<object>();
                    foreach(var c in All(form).Where(c=>c.Name=="service-title"||c.Name=="service-description"||c.Name.StartsWith("platform-value-"))) {
                        var rect=c.Bounds;
                        for(var parent=c.Parent;parent!=null;parent=parent.Parent){
                            if(!parent.ClientRectangle.Contains(rect))violations.Add(c.Name+" clipped by "+parent.Name+" "+rect+" / "+parent.ClientRectangle);
                            rect.Offset(parent.Left,parent.Top);
                        }
                        var preferred=TextRenderer.MeasureText(c.Text,c.Font);
                        if(c.Height<preferred.Height)violations.Add(c.Name+" text too short "+c.Height+" < "+preferred.Height);
                        labels.Add(new {name=c.Name,bounds=c.Bounds.ToString(),textHeight=preferred.Height});
                    }
                    var options=All(form).Single(c=>c.Name=="options").Controls.Cast<Control>().ToArray();
                    for(int a=0;a<options.Length;a++)for(int b=a+1;b<options.Length;b++)if(options[a].Bounds.IntersectsWith(options[b].Bounds))violations.Add("options overlap");
                    var orders=All(form).Single(c=>c.Name=="orders-view");if(orders.Height<140*scale)violations.Add("orders viewport too short: "+orders.Height);
                    string file="layout-"+size.Width+"x"+size.Height+"-"+(int)(scale*100)+(logOpen?"-log-open":"-log-closed")+".png";
                    using(var image=new Bitmap(form.Width,form.Height)){
                        form.DrawToBitmap(image,new Rectangle(0,0,form.Width,form.Height));
                        var colors=new HashSet<int>();for(int y=65;y<image.Height-40;y+=3)for(int x=24;x<image.Width-24;x+=3)colors.Add(image.GetPixel(x,y).ToArgb());
                        if(colors.Count<30)violations.Add("Native controls were not painted; invalid visual evidence");
                        image.Save(Path.Combine(dir,file),ImageFormat.Png);
                    }
                    cases.Add(new {width=size.Width,height=size.Height,scale,logOpen,violations,labels,image=file,ordersHeight=orders.Height});
                }
            }
            using(var toggle=new ToggleCheckBox{Text="開機啟動／異常復原",Checked=true})using(var image=new Bitmap(toggle.Width,toggle.Height)){
                using(var g=Graphics.FromImage(image))g.Clear(Color.Red);
                toggle.DrawToBitmap(image,new Rectangle(0,0,image.Width,image.Height));
                if(image.GetPixel(image.Width-2,image.Height-2).ToArgb()!=toggle.BackColor.ToArgb())throw new Exception("Toggle did not clear old background");
            }
            var json=new JavaScriptSerializer();string value=json.Serialize(new {ok=!cases.Any(c=>((IEnumerable<string>)c.GetType().GetProperty("violations").GetValue(c,null)).Any()),visibleToUser=false,inputUsed=false,navigationPerformed=false,cases});
            File.WriteAllText(report,value);
        }
    }
}
