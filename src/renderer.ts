import * as angular from "angular";
import * as ui from "@uirouter/angularjs";
import * as got from "got";
import * as cheerio from "cheerio";
import * as _ from "lodash";
import * as fs from "fs";
import * as moment from "moment";
import * as async from "async";
import {Globals} from "./main";
import WriteStream = NodeJS.WriteStream;
import * as cookie from "cookie";

const {dialog} = require('electron').remote;
const csv = require("csv-write-stream");

function bootstrap() {
    angular
        .module("ScrapeyPollenApp", ["ui.router"])
        .run(function ScrapeyPollenAppRun($rootScope: angular.IScope, $urlService: ui.UrlService) {
            $urlService.rules.otherwise("/home");
        })
        .config(function ScrapeyPollenAppConfig($stateProvider: ui.StateProvider) {
            $stateProvider
                .state('home', <ui.Ng1StateDeclaration> {
                    url: '/home',
                    component: 'homeComponent',
                })
                .state('jp_pollen', <ui.Ng1StateDeclaration> {
                    url: '/jp-pollen',
                    component: 'jpPollenComponent',
                })
                .state('usa_pollen', <ui.Ng1StateDeclaration> {
                    url: '/usa-pollen',
                    component: 'usaPollenComponent',
                })
            ;

        })
        .component('homeComponent', new HomeComponent())
        .component('jpPollenComponent', new JPPollenComponent())
        .component('usaPollenComponent', new USAPollenComponent())
    ;
}

class HomeComponent implements angular.IComponentOptions {
    public transclude: boolean = true;
    public templateUrl: string = "templates/home.html";
    public controller : any = () => {};
    public bindings: any = { };
}

class USAPollenComponent implements angular.IComponentOptions {
    public transclude: boolean = true;
    public templateUrl: string = "templates/usaPollen.html";
    public controller : any = USAPollenController;
    public bindings: any = { };
}

abstract class BaseController {
    public $rootScope : angular.IRootScopeService;

    public isCanceled : boolean = false;
    public loading : boolean = false;
    public displayError : string = "";
    public doneMsg : string = "";
    public selectedOutputFile : string = "";

    public numRequests : number = 0;
    public requestsMade : number = 0;
    public overallProgress : number = 0;

    constructor($rootScope : angular.IRootScopeService){
        this.$rootScope = $rootScope;
    }

    public cancel() : void {
        this.isCanceled = true;
    }

    public setLoading(val : boolean) : void {
        this.$rootScope.$applyAsync(() => {
            this.loading = val;
        });
    }

    public setDisplayError(val : string) : void {
        this.$rootScope.$applyAsync(() => {
            this.displayError = val;
        });
    }

    public setProgress(val : number) : void {
        this.$rootScope.$applyAsync(() => {

        });
    }

    public selectFile() : void {
        dialog.showSaveDialog(null, null, (result) => {
            this.$rootScope.$applyAsync(() => {
                this.selectedOutputFile = result;
            });
        });
    }

    public updateProgress() : void {
        this.$rootScope.$applyAsync(() => {
            this.requestsMade += 1;

            const progress = Math.ceil((this.requestsMade / this.numRequests) * 100);
            this.overallProgress = progress;
        });
    }

}

interface ZipcodePoint {
    Period : string;
    Index : number;
}

interface Zipcode {
    zipcode : string;
    status : string;
    points : ZipcodePoint[];
}


class USAPollenController extends BaseController {
    static $inject = ["$rootScope"];

    public daysBack : number = 30;
    public zipcodes : string = "";

    public zipcodeList : string[] = [];
    public zipcodeData : Zipcode[] = [];
    public updatedZipcodeData : Zipcode[] = [];

    public isStarted : boolean = false;
    private numPerSlice : number = 1000;
    public startIndex : number = 0;
    public endIndex : number = 0;

    constructor($rootScope : angular.IRootScopeService){
        super($rootScope);
    }

    public onSubmit() : void {
        if(!this.selectedOutputFile){
            this.setDisplayError("You must select an output file!");
            return;
        }

        if(!this.daysBack){
            this.setDisplayError("You must specify a days back value.");
            return;
        }

        this.zipcodeList = this.zipcodes.trim().split("\n");
        if(this.zipcodeList.length == 0){
            this.setDisplayError("You need to specify at least 1 zipcode.");
            return;
        }

        this.setDisplayError("");

        this.$rootScope.$applyAsync(() => {
            this.numRequests = this.zipcodeList.length;
            this.requestsMade = 0;
            this.setProgress(0);
            this.isCanceled = false;
        });

        this.zipcodeData = [];
        this.startIndex = 0;
        this.endIndex = this.numPerSlice;
        this.isStarted = true;
        this.processSlice();
    }

    public processSlice() : void {

        const zipcodeData = this.zipcodeList
                                .slice(this.startIndex, this.endIndex)
                                .map(f => { return {zipcode: f, status: "new", points: []} });

        async.eachLimit(zipcodeData, 10, (req, callback) => {
            if (this.isCanceled) {
                callback();
                return;
            }

            const url = `https://www.pollen.com/api/forecast/historic/pollen/${req.zipcode}/${this.daysBack}`;
            got(url, {headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Referer": `https://www.pollen.com/forecast/historic/pollen/${req.zipcode}`
                }})
                .then(response => {
                    const data : any = JSON.parse(response.body);
                    req.points = data["Location"]["periods"];

                    req.status = "done";
                    this.zipcodeData.push(req);

                    this.updateProgress();
                    callback();
                })
                .catch((err) => {

                    this.$rootScope.$applyAsync(() => {
                        req.status = "error";
                    });

                    callback();
                })
            ;

        }, (err) => {
            if(err) {
                this.setDisplayError(<string> err);
                return;
            }

            this.writeFile();

            this.startIndex += this.numPerSlice;
            this.endIndex += this.numPerSlice;

            if(this.startIndex <= this.numRequests){
                this.processSlice();
            }else{
                this.doneMsg = "Run complete! Your file is at " + this.selectedOutputFile;
            }

        });

    }

    public importAllZipcodes() : void {
        const data = fs.readFileSync("data/zip_code_database.csv", "utf8")
                        .split("\n")
                        .map(f => f.split(",")[0]);

        this.setLoading(true);
        this.$rootScope.$applyAsync(() => {
            this.zipcodes = data.slice(1).join("\n").trim();
            this.setLoading(false);
        });
    }

    public writeFile() : void {
        const longDateZip = _.sortBy(this.zipcodeData, f => f.points.length);
        const header = ["Zip code"].concat(<string[]> longDateZip[longDateZip.length - 1].points.map(f => {
            const mt = moment(f.Period, "YYYY-MM-DDTHH:mm:ss");
            return mt.format("YYYY-MM-DD");
        }));
        const writer : WriteStream = csv({ headers: header });

        writer.pipe(fs.createWriteStream(this.selectedOutputFile));
        this.zipcodeData.forEach(f => {
            const data = [f.zipcode].concat(f.points.map(fx => fx.Index.toString()));
            writer.write(<any> data);
        });

        writer.end();
    }

    public syncData() : void {
        this.updatedZipcodeData = [].concat(this.zipcodeData);
    }
}

class JPPollenComponent implements angular.IComponentOptions {
    public transclude: boolean = true;
    public templateUrl: string = "templates/jpPollen.html";
    public controller : any = JPPollenController;
    public bindings: any = { };
}

interface PollenData {
    status : string;
    date : string;
    sum : number;
    points : number[];
}

interface City {
    name : string;
    id : string;
    displayName : string;
    data : PollenData[];
    progressPercent : number;
}

class JPPollenController extends BaseController {

    static $inject = ["$rootScope"];
    public $rootScope : angular.IRootScopeService;

    public tab : "list" | "progress" | "none" = "none";

    public dateArray : string[] = [];
    public cities : City[] = [];

    public startDate : Date = moment().subtract(1, "month").toDate();
    public endDate : Date = new Date();

    constructor($rootScope : angular.IRootScopeService){
        super($rootScope);
    }

    public $onInit() : void {

    }

    public onSubmit() : void {
        if(!this.startDate || !this.endDate){
            this.setDisplayError("You must specify both a start and end date!");
            return;
        }

        if(!this.selectedOutputFile){
            this.setDisplayError("You must select an output file!");
            return;
        }

        this.setLoading(true);
        this.setDisplayError(null);

        this.getCities().then(results => {
            const datePart = moment(this.startDate).format("YYYYMMDD");
            const url = `http://weathernews.jp/pollen/xml/${results[0].id}/${datePart}.xml`;

            got(url)
            .then(() => {
                this.$rootScope.$applyAsync(() => {
                    this.tab = "progress";
                });

                this.doFetch(results);
            })
            .catch(err => {
                console.log(err);
                this.setLoading(false);
                this.setDisplayError("Invalid 'Start Date'. Maybe its too far in the past?");
            });

        });

    }

    private doFetch(cities : City[]) : void {
        const dateArray : string[] = [];
        const d = moment(this.startDate);
        const end = moment(this.endDate);

        this.setLoading(false);

        while(d.isSameOrBefore(end)){
            dateArray.push( d.format("YYYYMMDD") );
            d.add(1, "day");
        }

        const cityDateRequest = _.chain(cities)
                                 .map(f => {
                                    return dateArray.map(d => { return {city: f, date: d}; });
                                 })
                                 .flatten()
                                 .value();

        this.dateArray = dateArray;

        this.$rootScope.$applyAsync(() => {
            this.numRequests = cityDateRequest.length;
            this.requestsMade = 0;
            this.setProgress(0);
            this.isCanceled = false;

            this.cities = cities.map(f => {
                f.data = dateArray.map(d => { return {status: "new", sum: 0, date: d, points: []}; });
                return f;
            });

            async.eachLimit(cityDateRequest, 10, (req, callback) => {

                if(this.isCanceled){
                    callback();
                    return;
                }

                const targetCity = this.cities.find(f => f == req.city);
                const targetDate = targetCity.data.find(f => f.date == req.date);

                const url = `http://weathernews.jp/pollen/xml/${req.city.id}/${req.date}.xml`;

                got(url)
                .then(response => {
                    const xml$ = cheerio.load(response.body);
                    const pollen = xml$("pollen").text();

                    this.$rootScope.$applyAsync(() => {
                        targetDate.status = "done";
                    });

                    if(pollen){
                        targetDate.points = pollen.split(",").map(f => f.length ? parseInt(f) : 0);
                        targetDate.sum = _.sum(targetDate.points);
                    }

                    this.writeData();
                    callback();
                })
                .catch(err => {
                    if(this.isCanceled){
                        return;
                    }

                    this.$rootScope.$applyAsync(() => {
                        targetDate.status = "error";
                    });

                    callback();
                });

                this.updateProgress();
            }, (err) => {
                if(err) {
                    this.setDisplayError(<string> err);
                    return;
                }

                this.doneMsg = "Run complete! Your file is at " + this.selectedOutputFile;
            });

        });

    }
    public fetchCities() : void {

        this.setLoading(true);

        this.getCities()
            .then(results => {
                this.setLoading(false);
                this.$rootScope.$applyAsync(() => {
                    this.cities = results;
                    this.tab = "list";
                });
            })
            .catch((err) => {
                this.setLoading(false);
                this.setDisplayError(err);
            });
    }

    public getCities(): Promise<City[]> {
        return new Promise<City[]>((resolve, reject) => {
            got("http://weathernews.jp/pollen/xml/obs.xml")
                .then(response => {
                    const xml$ = cheerio.load(response.body);
                    const paired = _.zip(xml$("name").text().split(","),
                                          xml$("id").text().split(","));
                    const data = _.map(paired, f => {
                        return {name: f[0], id: f[1], displayName: f[0] + " (" + f[1] + ")",
                                data: [], progressPercent: 0};
                    });

                    resolve(data);
                })
                .catch((err) => {
                    reject(err);
                });
        });
    }

    private writeData() : void {
        const header = ["Id", "Name"].concat(this.dateArray);
        const writer : WriteStream = csv({ headers: header });

        writer.pipe(fs.createWriteStream(this.selectedOutputFile));
        this.cities.forEach(f => {
            const sums = f.data.map(d => d.sum.toString());
            const data = [f.id, f.name].concat(sums);
            writer.write((<any> data));
        });
        writer.end();
    }

    public downloadCSV() : void {

        dialog.showSaveDialog(null, null, (result) => {
            if(!result){
                return;
            }

            const writer : WriteStream = csv({ headers: ["Id", "Name"]});
            writer.pipe(fs.createWriteStream(result));
            this.cities.map(f => [f.id, f.name]).forEach(f => {
                writer.write((<any> f));
            });
            writer.end();
        });

    }
}

bootstrap();