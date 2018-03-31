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
            ;

        })
        .component('homeComponent', new HomeComponent())
        .component('jpPollenComponent', new JPPollenComponent())
    ;
}

class HomeComponent implements ng.IComponentOptions {
    public transclude: boolean = true;
    public templateUrl: string = "templates/home.html";
    public controller : any = HomeController;
    public bindings: any = { };
}

class HomeController {

}

class JPPollenComponent implements ng.IComponentOptions {
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

class JPPollenController {

    static $inject = ["$rootScope"];

    public $rootScope : angular.IRootScopeService;

    public tab : "list" | "progress" | "none" = "none";

    public dateArray : string[] = [];
    public cities : City[] = [];

    public loading : boolean = false;
    public displayError : string = "";
    public selectedOutputFile : string = "/home/ashish/Downloads/jp_output.csv";

    public startDate : Date = moment().subtract(2, "month").toDate();
    public endDate : Date = new Date();

    public numRequests : number = 0;
    public requestsMade : number = 0;
    public overallProgress : number = 0;

    constructor($rootScope : angular.IRootScopeService){
        this.$rootScope = $rootScope;
    }

    public $onInit() : void {

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

    public onSubmit() : void {
        if(!this.startDate || !this.endDate){
            this.setDisplayError("You must specify both a start and end date!");
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

        const cityDateRequest = _.flatten(cities.map(f => {
            return dateArray.map(d => { return {city: f, date: d}; });
        }));

        this.dateArray = dateArray;

        this.$rootScope.$applyAsync(() => {
            this.numRequests = cityDateRequest.length;
            this.requestsMade = 0;
            this.setProgress(0);

            this.cities = cities.map(f => {
                f.data = dateArray.map(d => { return {status: "new", sum: 0, date: d, points: []}; });
                return f;
            });

            async.eachLimit(cityDateRequest, 5, (req, callback) => {

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
                        targetDate.points = pollen.split(",").map(f => parseInt(f));
                        targetDate.sum = _.sum(targetDate.points);
                    }

                    this.writeData();
                    callback();
                })
                .catch(err => {
                    this.$rootScope.$applyAsync(() => {
                        targetDate.status = "error";
                    });
                    callback();
                });

                this.requestsMade += 1;
                const progress = Math.ceil((this.requestsMade / this.numRequests) * 100);
                this.setProgress(progress);
            }, (err) => {
                if(err) {
                    this.setDisplayError(<string> err);
                    return;
                }

            });

        });

    }

    private setProgress(val : number) : void {
        this.$rootScope.$applyAsync(() => {
            this.overallProgress = val;
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

    public selectFile() : void {
        dialog.showSaveDialog(null, null, (result) => {
            this.$rootScope.$applyAsync(() => {
               this.selectedOutputFile = result;
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