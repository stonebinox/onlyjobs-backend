import OpenAI from "openai";

import JobListing from "../models/JobListing";
import { jobDetailsExtractorInstructions } from "../utils/jobDetailsExtractorInstructions";
import {
  scrapeWeWorkRemotely,
  scrapeRemoteOK,
  scrapeLandingJobs,
  scrapeNoDesk,
  scrapeTryRemoteJobs,
  scrapeNearJobs,
  scrapeCryptoJobsList,
  scrapeWeb3CareerJobs,
  // scrapeWellfound,
} from "./scrapers";
import { ScrapedJob } from "./scrapers";

async function enrichJobWithOpenAI(job: ScrapedJob) {
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    const response = await openai.chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4o-mini",
      messages: [
        {
          role: "developer",
          content: jobDetailsExtractorInstructions,
        },
        { role: "user", content: JSON.stringify(job) },
      ],
    });

    const jsonText = response.choices[0].message?.content || "";
    const parsed = JSON.parse(jsonText);

    return parsed;
  } catch (err: any) {
    console.error("OpenAI enrichment failed:", err.message);
    return null;
  }
}

export async function runDailyJobScraping(): Promise<void> {
  console.time("Job scraper");

  try {
    const existingJobs = await JobListing.find({}, { url: 1 });
    const existingURLs = new Set(
      existingJobs.map((j) => j.url.trim().toLowerCase())
    );

    // to add support to the following sites:
    // https://cryptocurrencyjobs.co/?ref=nodesk
    // https://javascript.jobs/remote

    const sources = [
      // {
      //   name: "Wellfound",
      //   url: "https://wellfound.com/remote",
      //   scraper: scrapeWellfound,
      // },
      {
        name: "Web3 Careers",
        url: "https://web3.career/remote-jobs",
        scraper: scrapeWeb3CareerJobs,
      },
      {
        name: "Cryptocurrency Jobs",
        url: "https://cryptocurrencyjobs.co",
        scraper: scrapeCryptoJobsList,
      },
      {
        name: "NEAR Careers",
        url: "https://api.getro.com/api/v2/collections/1338/search/jobs",
        scraper: scrapeNearJobs,
      },
      {
        name: "TryRemote - Freelance",
        url: "https://tryremote.com/remote-freelance-tech-jobs",
        scraper: scrapeTryRemoteJobs,
      },
      {
        name: "TryRemote - Full Time",
        url: "https://tryremote.com/remote-full-time-tech-jobs",
        scraper: scrapeTryRemoteJobs,
      },
      {
        name: "TryRemote",
        url: "https://tryremote.com/remote-worldwide-tech-jobs",
        scraper: scrapeTryRemoteJobs,
      },
      {
        name: "NoDesk - Customer Support",
        url: "https://nodesk.co/remote-jobs/customer-support/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Design",
        url: "https://nodesk.co/remote-jobs/design/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Engineering",
        url: "https://nodesk.co/remote-jobs/engineering/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Marketing",
        url: "https://nodesk.co/remote-jobs/marketing/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Non-Tech",
        url: "https://nodesk.co/remote-jobs/non-tech/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Operations",
        url: "https://nodesk.co/remote-jobs/operations/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Product",
        url: "https://nodesk.co/remote-jobs/product/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - Sales",
        url: "https://nodesk.co/remote-jobs/sales/",
        scraper: scrapeNoDesk,
      },
      {
        name: "NoDesk - All Other",
        url: "https://nodesk.co/remote-jobs/",
        scraper: scrapeNoDesk,
      },
      {
        name: "WeWorkRemotely - Full Stack",
        url: "https://weworkremotely.com/categories/remote-full-stack-programming-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Backend",
        url: "https://weworkremotely.com/categories/remote-back-end-programming-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Design",
        url: "https://weworkremotely.com/categories/remote-design-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Frontend",
        url: "https://weworkremotely.com/categories/remote-front-end-programming-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - DevOps",
        url: "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Customer Support",
        url: "https://weworkremotely.com/categories/remote-customer-support-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Management and Finance",
        url: "https://weworkremotely.com/categories/remote-management-and-finance-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Sales and Marketing",
        url: "https://weworkremotely.com/categories/remote-sales-and-marketing-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Other",
        url: "https://weworkremotely.com/categories/all-other-remote-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "WeWorkRemotely - Product",
        url: "https://weworkremotely.com/categories/remote-product-jobs",
        scraper: scrapeWeWorkRemotely,
      },
      {
        name: "RemoteOK",
        url: "https://remoteok.com/remote-dev-jobs",
        scraper: scrapeRemoteOK,
      },
      {
        name: "Landing.jobs",
        url: "https://landing.jobs/jobs",
        scraper: scrapeLandingJobs,
      },
    ];

    for (const source of sources) {
      console.log(`Scraping jobs from ${source.name}...`);
      const jobs = await source.scraper(source.url);

      for (const job of jobs) {
        job.source = source.name;
        job.scrapedDate = new Date();

        if (!job.url || job.url.trim() === "") {
          console.error("Job URL is missing:", job);
          continue;
        }

        const normalizedUrl = job.url?.trim().toLowerCase();

        if (!existingURLs.has(normalizedUrl)) {
          const enriched = await enrichJobWithOpenAI(job);

          if (enriched) {
            job.title = enriched.title || job.title;
            job.company = enriched.company || job.company;
            job.location = enriched.location || job.location;
            job.source = enriched.source || job.source;
            job.tags = enriched.tags || job.tags || [];
            job.postedDate = new Date(enriched.postedDate || Date.now());
            job.url = enriched.url || job.url;
            job.description =
              enriched.description ||
              job.description ||
              "-- No description available --";
            job.salary = enriched.salary;
            job.scrapedDate = new Date(enriched.scrapedDate || Date.now());
          }

          await JobListing.create(job);
          existingURLs.add(normalizedUrl);
          console.log(`Saved new job: ${job.title} at ${job.company}`);
        } else {
          console.log(`Job already exists: ${job.title} at ${job.company}`);
        }
      }
    }
  } catch (error) {
    console.error("Error during job scraping:", error);
  } finally {
    console.timeEnd("Job scraper");
  }
}

export default runDailyJobScraping;
